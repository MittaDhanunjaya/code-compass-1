/**
 * Task-based model routing: heuristic rules for planning (cheap/fast),
 * patch (code-optimized), and optional reviewer model.
 */

import type { ProviderId } from "./providers";

export type TaskType = "planning" | "qa" | "patch" | "review" | "chat" | "inline_edit" | "debug";

export type ResolvedModel = {
  providerId: ProviderId;
  model: string | undefined;
}

/** Heuristic: cheap/fast for planning and Q&A; code-optimized for patches; optional reviewer. */
const ROUTING_HEURISTIC: Record<TaskType, ResolvedModel> = {
  planning: { providerId: "openrouter", model: "openrouter/free" },
  qa: { providerId: "openrouter", model: "openrouter/free" },
  patch: { providerId: "openrouter", model: "openrouter/free" },
  review: { providerId: "openrouter", model: "openrouter/free" },
  chat: { providerId: "openrouter", model: "openrouter/free" },
  inline_edit: { providerId: "openrouter", model: "openrouter/free" },
  debug: { providerId: "openrouter", model: "openrouter/free" },
};

/** Optional override per task (e.g. from DB or env). Set at runtime. */
let overrides: Partial<Record<TaskType, ResolvedModel>> = {};

/**
 * Set routing overrides (e.g. from workspace or user prefs).
 * Call from API routes after loading user/workspace config.
 */
export function setTaskRoutingOverrides(o: Partial<Record<TaskType, ResolvedModel>>): void {
  overrides = { ...overrides, ...o };
}

/**
 * Clear overrides (e.g. between requests if using a shared process).
 */
export function clearTaskRoutingOverrides(): void {
  overrides = {};
}

/**
 * Resolve provider and model for a task. Uses override if set, else heuristic.
 */
export function getModelForTask(task: TaskType): ResolvedModel {
  const o = overrides[task];
  if (o) return o;
  return ROUTING_HEURISTIC[task];
}

/**
 * Apply env overrides for "code-optimized" and "reviewer" when set.
 * e.g. ROUTING_PATCH_MODEL=openrouter/deepseek/deepseek-coder-6.7b:free
 */
export function applyEnvRouting(): void {
  const patchEnv = process.env.ROUTING_PATCH_MODEL;
  const reviewEnv = process.env.ROUTING_REVIEW_MODEL;
  const planningEnv = process.env.ROUTING_PLANNING_MODEL;
  if (patchEnv?.trim()) {
    const [provider, model] = parseProviderModel(patchEnv);
    if (provider) overrides.patch = { providerId: provider, model: model ?? patchEnv };
  }
  if (reviewEnv?.trim()) {
    const [provider, model] = parseProviderModel(reviewEnv);
    if (provider) overrides.review = { providerId: provider, model: model ?? reviewEnv };
  }
  if (planningEnv?.trim()) {
    const [provider, model] = parseProviderModel(planningEnv);
    if (provider) overrides.planning = { providerId: provider, model: model ?? planningEnv };
  }
}

const PROVIDER_IDS = ["openrouter", "openai", "gemini", "perplexity", "ollama", "lmstudio"] as const;

function parseProviderModel(value: string): [ProviderId | null, string | undefined] {
  const firstSlash = value.indexOf("/");
  if (firstSlash === -1) return [null, undefined];
  const prefix = value.slice(0, firstSlash).toLowerCase();
  const rest = value.slice(firstSlash + 1);
  if (PROVIDER_IDS.includes(prefix as ProviderId))
    return [prefix as ProviderId, rest || undefined];
  return [null, undefined];
}
