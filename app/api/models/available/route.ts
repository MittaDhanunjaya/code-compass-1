import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";

/**
 * GET /api/models/available
 * Returns default models + user's models (with hasKey, no key value). Optionally user's groups.
 * If no default models exist, seeds them via DB function so the catalog is never empty.
 */
export async function GET(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let defaultModelsRes = await supabase
    .from("models")
    .select("id, label, provider, model_slug, is_default, is_free, capabilities")
    .eq("is_default", true)
    .order("provider");

  if (
    defaultModelsRes.data &&
    Array.isArray(defaultModelsRes.data) &&
    defaultModelsRes.data.length === 0
  ) {
    const { error: seedError } = await supabase.rpc("seed_default_models");
    if (!seedError) {
      defaultModelsRes = await supabase
        .from("models")
        .select("id, label, provider, model_slug, is_default, is_free, capabilities")
        .eq("is_default", true)
        .order("provider");
    }
    // If seed_default_models RPC doesn't exist (migrations not run), catalog stays empty
  }

  const [userModelsRes, groupsRes, providerKeysRes] = await Promise.all([
    supabase.from("user_models").select("id, model_id, enabled, alias_label, api_key_encrypted").eq("user_id", user.id),
    supabase.from("model_groups").select("id, label, description").eq("user_id", user.id),
    supabase.from("provider_keys").select("provider").eq("user_id", user.id),
  ]);

  let defaultModelsData = defaultModelsRes.data ?? [];
  // Inline fallback when DB has no default models (migrations not run or seed failed) so UI never shows "No models"
  if (defaultModelsData.length === 0) {
    defaultModelsData = [
      { id: "inline-ollama", label: "Ollama (local)", provider: "ollama", model_slug: "qwen:latest", is_default: true, is_free: true, capabilities: { chat: true, code: true } },
      { id: "inline-openrouter", label: "OpenRouter Free", provider: "openrouter", model_slug: "openrouter/free", is_default: true, is_free: true, capabilities: { chat: true, code: true } },
      { id: "inline-gemini", label: "Google Gemini", provider: "gemini", model_slug: "gemini-2.0-flash", is_default: true, is_free: true, capabilities: { chat: true, code: true } },
    ];
  }

  const providersWithKey = new Set((providerKeysRes.data ?? []).map((r) => r.provider));

  const defaultModels = defaultModelsData.map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    modelSlug: m.model_slug,
    isDefault: m.is_default,
    isFree: m.is_free,
    capabilities: m.capabilities ?? { chat: true, code: true },
    hasKey: m.provider === "ollama" ? true : providersWithKey.has(m.provider),
  }));

  const userModelIds = new Set((userModelsRes.data ?? []).map((um) => um.model_id));
  const allModelsRes = await supabase
    .from("models")
    .select("id, label, provider, model_slug, is_default, is_free, capabilities");
  const allModels = allModelsRes.data ?? [];
  const userLinkedModels = allModels.filter((m) => userModelIds.has(m.id));

  const userModels = userLinkedModels.map((m) => {
    const um = (userModelsRes.data ?? []).find((u) => u.model_id === m.id);
    const hasStoredKey = um?.api_key_encrypted != null;
    const hasKey = hasStoredKey || (m.is_default && (m.provider === "ollama" || providersWithKey.has(m.provider)));
    return {
      id: um?.id,
      modelId: m.id,
      label: (um?.alias_label ?? m.label) as string,
      provider: m.provider,
      modelSlug: m.model_slug,
      isDefault: m.is_default,
      isFree: m.is_free,
      capabilities: m.capabilities ?? { chat: true, code: true },
      hasKey,
      enabled: um?.enabled ?? true,
    };
  });

  const groups = (groupsRes.data ?? []).map((g) => ({
    id: g.id,
    label: g.label,
    description: g.description ?? undefined,
  }));

  return NextResponse.json({
    defaultModels,
    userModels,
    groups,
  });
}
