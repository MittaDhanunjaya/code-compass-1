/**
 * Model Capability Registry (static – do not guess).
 * Used to validate model can perform a task before starting; auto-switch if not.
 * Keys: model_slug or "provider:model" (e.g. gemini:gemini-2.0-flash).
 */

export type PlanningStrength = true | "weak" | false;

export type ModelCapability = {
  /** Supports streaming responses */
  streaming: boolean;
  /** Supports agent planning (JSON plan generation) */
  planning: PlanningStrength;
  /** Max context/output tokens (approximate) */
  maxTokens?: number;
  /** Free tier – stricter rate limits, may hit 429 */
  rateLimited?: boolean;
  /** Preferred for planning tasks (strong reasoning) */
  planningPreferred?: boolean;
};

/** Static registry – add models as we learn their capabilities. */
export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // OpenAI
  "openai/gpt-4o": { streaming: true, planning: true, maxTokens: 128_000, planningPreferred: true },
  "openai/gpt-4o-mini": { streaming: true, planning: true, maxTokens: 128_000 },
  "openai/gpt-4-turbo": { streaming: true, planning: true, maxTokens: 128_000 },
  "openai/gpt-3.5-turbo": { streaming: true, planning: true, maxTokens: 16_000 },
  "openai/gpt-oss-120b:free": { streaming: true, planning: true, rateLimited: true },

  // Anthropic
  "anthropic/claude-3-5-sonnet": { streaming: true, planning: true, maxTokens: 200_000, planningPreferred: true },
  "anthropic/claude-3-5-haiku-latest": { streaming: true, planning: true, maxTokens: 200_000 },
  "anthropic/claude-3-haiku": { streaming: true, planning: true, maxTokens: 200_000 },

  // DeepSeek – R1 has no streaming, strong planning
  "deepseek/deepseek-r1-0528:free": { streaming: false, planning: true, rateLimited: true, planningPreferred: true },
  "deepseek/deepseek-r1-0528-qwen3-8b:free": { streaming: false, planning: true, rateLimited: true },
  "deepseek/deepseek-chat:free": { streaming: true, planning: true, rateLimited: true },
  "deepseek/deepseek-chat-v3-0324": { streaming: true, planning: true },
  "deepseek/deepseek-coder-v2": { streaming: true, planning: true },
  "tngtech/deepseek-r1t2-chimera:free": { streaming: false, planning: true, rateLimited: true },
  "tngtech/deepseek-r1t-chimera:free": { streaming: false, planning: true, rateLimited: true },

  // Google Gemini
  "google/gemini-2.0-flash": { streaming: true, planning: true },
  "google/gemini-2.0-flash-exp": { streaming: true, planning: true },
  "gemini:gemini-2.0-flash": { streaming: true, planning: true, rateLimited: true },
  "gemini:gemini-flash": { streaming: true, planning: "weak", rateLimited: true },
  "gemini:gemini-1.5-flash": { streaming: true, planning: true, rateLimited: true },
  "gemini:gemini-1.5-pro": { streaming: true, planning: true, rateLimited: true },

  // Qwen
  "qwen/qwen3-coder:free": { streaming: true, planning: true, rateLimited: true },
  "qwen/qwen-2.5-coder-32b-instruct:free": { streaming: true, planning: true, rateLimited: true },
  "qwen/qwen-2.5-coder-32b-instruct": { streaming: true, planning: true },
  "qwen/qwen-2.5-coder-7b-instruct": { streaming: true, planning: true },

  // Arcee
  "arcee-ai/trinity-large-preview:free": { streaming: true, planning: true, rateLimited: true },
  "arcee-ai/trinity-mini:free": { streaming: true, planning: true, rateLimited: true },

  // Meta Llama
  "meta-llama/llama-3.3-70b-instruct:free": { streaming: true, planning: true, rateLimited: true },
  "meta-llama/llama-3.2-3b-instruct:free": { streaming: true, planning: "weak", rateLimited: true },
  "meta-llama/llama-3.2-90b-vision-instruct": { streaming: true, planning: true },

  // Perplexity
  "perplexity:sonar": { streaming: true, planning: "weak" },
  "perplexity:sonar-pro": { streaming: true, planning: "weak" },

  // OpenRouter router / fallbacks
  "openrouter/free": { streaming: true, planning: true, rateLimited: true },
  "openrouter/aurora-alpha": { streaming: true, planning: true, rateLimited: true },

  // Misc
  "stepfun/step-3.5-flash:free": { streaming: true, planning: true, rateLimited: true },
  "z-ai/glm-4.5-air:free": { streaming: true, planning: true, rateLimited: true },
  "nvidia/nemotron-3-nano-30b-a3b:free": { streaming: true, planning: true, rateLimited: true },
  "upstage/solar-pro-3:free": { streaming: true, planning: true, rateLimited: true },
  "mistralai/mistral-7b-instruct:free": { streaming: true, planning: "weak", rateLimited: true },
  "mistralai/mistral-small-3.1-24b-instruct": { streaming: true, planning: true },
};

/** Normalize model id for lookup (provider:slug or slug) */
export function normalizeModelKey(providerId: string, modelSlug: string): string {
  if (providerId === "openrouter") return modelSlug;
  if (providerId === "gemini" || providerId === "perplexity") {
    return `${providerId}:${modelSlug}`;
  }
  return modelSlug;
}

/** Get capabilities for a model; returns undefined if unknown */
export function getModelCapabilities(
  providerId: string,
  modelSlug: string
): ModelCapability | undefined {
  const key = normalizeModelKey(providerId, modelSlug);
  const exact = MODEL_CAPABILITIES[key];
  if (exact) return exact;
  // Fallback: try slug alone (OpenRouter-style)
  if (providerId === "openrouter") return MODEL_CAPABILITIES[modelSlug];
  return undefined;
}

export type TaskRequirement = "streaming" | "planning" | "planningPreferred";

/** Check if model meets task requirements */
export function modelMeetsRequirement(
  providerId: string,
  modelSlug: string,
  requirement: TaskRequirement
): boolean {
  const cap = getModelCapabilities(providerId, modelSlug);
  if (!cap) return true; // Unknown model – allow (don't block)
  switch (requirement) {
    case "streaming":
      return cap.streaming;
    case "planning":
      return cap.planning === true || cap.planning === "weak";
    case "planningPreferred":
      return cap.planningPreferred === true || cap.planning === true;
    default:
      return true;
  }
}

/** Find best fallback from configs that meets requirements */
export function findCapableFallback<T extends { providerId: string; modelSlug: string; modelLabel: string }>(
  configs: T[],
  currentIndex: number,
  requirements: TaskRequirement[]
): T | undefined {
  for (let i = currentIndex + 1; i < configs.length; i++) {
    const c = configs[i];
    const meets = requirements.every((r) => modelMeetsRequirement(c.providerId, c.modelSlug, r));
    if (meets) return c;
  }
  return undefined;
}
