import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import type { ProviderId } from "@/lib/llm/providers";
import { PROVIDERS } from "@/lib/llm/providers";
import type { ModelInvocationConfig } from "./types";

const PROVIDER_ID_SET = new Set<string>(PROVIDERS);

function toProviderId(provider: string): ProviderId {
  if (PROVIDER_ID_SET.has(provider)) return provider as ProviderId;
  if (provider === "custom") return "openrouter";
  return "openrouter";
}

/**
 * Resolve a single model by ID to invocation config.
 * Uses user_models.api_key_encrypted if present, else provider_keys for that provider.
 */
export async function resolveModelId(
  supabase: SupabaseClient,
  userId: string,
  modelId: string
): Promise<ModelInvocationConfig | null> {
  const { data: model, error: modelError } = await supabase
    .from("models")
    .select("id, label, provider, model_slug, is_default, is_free")
    .eq("id", modelId)
    .single();

  if (modelError || !model) return null;

  const providerId = toProviderId(model.provider);
  let apiKey = "";

  const { data: userModel } = await supabase
    .from("user_models")
    .select("api_key_encrypted, enabled")
    .eq("user_id", userId)
    .eq("model_id", modelId)
    .maybeSingle();

  if (userModel?.api_key_encrypted && userModel.enabled) {
    try {
      apiKey = decrypt(userModel.api_key_encrypted);
    } catch {
      return null;
    }
  } else if (model.is_default) {
    const { data: keyRow } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", userId)
      .eq("provider", providerId)
      .maybeSingle();
    if (keyRow?.key_encrypted) {
      try {
        apiKey = decrypt(keyRow.key_encrypted);
      } catch {
        // ignore
      }
    }
    // Ollama and other local providers may not have a key
    if (providerId === "ollama") apiKey = "";
  } else {
    return null;
  }

  const label = (userModel as { alias_label?: string } | null)?.alias_label ?? model.label;
  return {
    modelId: model.id,
    modelLabel: label,
    providerId,
    modelSlug: model.model_slug,
    apiKey,
  };
}

/**
 * Resolve a model group to an array of invocation configs (ordered by priority, then role).
 * Only includes models that are enabled and have keys where required.
 */
export async function resolveModelGroupId(
  supabase: SupabaseClient,
  userId: string,
  modelGroupId: string
): Promise<ModelInvocationConfig[]> {
  const { data: group, error: groupError } = await supabase
    .from("model_groups")
    .select("id, user_id")
    .eq("id", modelGroupId)
    .eq("user_id", userId)
    .single();

  if (groupError || !group) return [];

  const { data: members, error: membersError } = await supabase
    .from("model_group_members")
    .select("model_id, role, priority")
    .eq("group_id", modelGroupId)
    .order("priority", { ascending: true });

  if (membersError || !members?.length) return [];

  const configs: ModelInvocationConfig[] = [];
  for (const m of members) {
    const config = await resolveModelId(supabase, userId, m.model_id);
    if (config) {
      const role = (m.role === "planner" || m.role === "coder" || m.role === "reviewer")
        ? m.role
        : "coder";
      configs.push({ ...config, role });
    }
  }
  return configs;
}

const ROLES: ("planner" | "coder" | "reviewer")[] = ["planner", "coder", "reviewer"];

/**
 * Pick the config for a given role from a list of configs (e.g. from a model group).
 * Falls back to the first config if no config has that role.
 */
export function getConfigByRole(
  configs: ModelInvocationConfig[],
  role: "planner" | "coder" | "reviewer"
): ModelInvocationConfig | null {
  if (!configs.length) return null;
  const withRole = configs.find((c) => c.role === role);
  return withRole ?? configs[0] ?? null;
}

/**
 * Get the user's saved default model group id, if any (and group still exists).
 */
export async function getDefaultGroupIdOrNull(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data } = await supabase
    .from("user_agent_preferences")
    .select("default_model_group_id")
    .eq("user_id", userId)
    .maybeSingle();
  const groupId = data?.default_model_group_id ?? null;
  if (!groupId) return null;
  const { data: group } = await supabase
    .from("model_groups")
    .select("id")
    .eq("id", groupId)
    .eq("user_id", userId)
    .maybeSingle();
  return group ? groupId : null;
}

/**
 * Build the app's best default group from all models the user can use:
 * default models (free or with provider key) + user-added models with API key.
 * Ordered: free first, then by label; roles assigned as planner, coder, reviewer, then coder.
 */
export async function resolveDefaultGroup(
  supabase: SupabaseClient,
  userId: string
): Promise<ModelInvocationConfig[]> {
  const [defaultModelsRes, userModelsRes, providerKeysRes] = await Promise.all([
    supabase.from("models").select("id, label, provider, model_slug, is_default, is_free").eq("is_default", true).order("label"),
    supabase.from("user_models").select("model_id, api_key_encrypted, enabled, alias_label").eq("user_id", userId),
    supabase.from("provider_keys").select("provider").eq("user_id", userId),
  ]);
  const defaultModels = defaultModelsRes.data ?? [];
  const userModels = userModelsRes.data ?? [];
  const providersWithKey = new Set((providerKeysRes.data ?? []).map((r) => r.provider));

  const modelIdsToResolve = new Set<string>();
  for (const m of defaultModels) {
    if (m.is_free || providersWithKey.has(m.provider) || m.provider === "ollama") {
      modelIdsToResolve.add(m.id);
    }
  }
  for (const um of userModels) {
    if (um.enabled && um.api_key_encrypted) modelIdsToResolve.add(um.model_id);
  }

  const configs: ModelInvocationConfig[] = [];
  for (const modelId of modelIdsToResolve) {
    const c = await resolveModelId(supabase, userId, modelId);
    if (c) configs.push(c);
  }
  // Prefer free models first, then sort by label for stable order
  configs.sort((a, b) => {
    const aFree = defaultModels.some((m) => m.id === a.modelId && m.is_free);
    const bFree = defaultModels.some((m) => m.id === b.modelId && m.is_free);
    if (aFree !== bFree) return aFree ? -1 : 1;
    return a.modelLabel.localeCompare(b.modelLabel);
  });
  const withRoles: ModelInvocationConfig[] = configs.map((c, i) => ({
    ...c,
    role: ROLES[i] ?? "coder",
  }));
  return withRoles;
}

/**
 * Resolve modelId or modelGroupId to one or more ModelInvocationConfig.
 * If neither is provided, uses user's saved default group or app-computed best default.
 */
export async function resolveInvocationConfig(
  supabase: SupabaseClient,
  userId: string,
  options: { modelId?: string; modelGroupId?: string }
): Promise<ModelInvocationConfig[]> {
  if (options.modelGroupId) {
    return resolveModelGroupId(supabase, userId, options.modelGroupId);
  }
  if (options.modelId) {
    const c = await resolveModelId(supabase, userId, options.modelId);
    return c ? [c] : [];
  }
  const savedGroupId = await getDefaultGroupIdOrNull(supabase, userId);
  if (savedGroupId) {
    const groupConfigs = await resolveModelGroupId(supabase, userId, savedGroupId);
    if (groupConfigs.length > 0) return groupConfigs;
  }
  return resolveDefaultGroup(supabase, userId);
}

/** Slug substrings that indicate a "fast" model suitable for tab completion (lower latency). */
const FAST_MODEL_PATTERNS = [
  "gpt-4o-mini",
  "gpt-3.5-turbo",
  "claude-3-haiku",
  "claude-3-5-haiku",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "deepseek-coder",
  "deepseek-r1",
];

function isFastModel(slug: string): boolean {
  const lower = slug.toLowerCase();
  return FAST_MODEL_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Prefer a fast/small model for tab completion when available (lower latency).
 * Returns first model from default group that matches fast patterns; otherwise null (caller uses best default).
 */
export async function getCompletionModel(
  supabase: SupabaseClient,
  userId: string
): Promise<{ providerId: ProviderId; modelSlug: string; label: string } | null> {
  const configs = await resolveDefaultGroup(supabase, userId);
  const fast = configs.find((c) => c.providerId === "openrouter" && isFastModel(c.modelSlug));
  if (!fast) return null;
  return {
    providerId: fast.providerId,
    modelSlug: fast.modelSlug,
    label: fast.modelLabel,
  };
}

/**
 * Best default model for chat, inline-edit, tab completion, etc.
 * Uses the same logic as the Agent default group: free models first, then by label.
 * Returns the first usable model so the app has one consistent "best default" the user can override.
 */
export async function getBestDefaultModel(
  supabase: SupabaseClient,
  userId: string
): Promise<{ providerId: ProviderId; modelId: string; modelSlug: string; label: string } | null> {
  const configs = await resolveDefaultGroup(supabase, userId);
  const first = configs[0];
  if (!first) return null;
  return {
    providerId: first.providerId,
    modelId: first.modelId,
    modelSlug: first.modelSlug,
    label: first.modelLabel,
  };
}
