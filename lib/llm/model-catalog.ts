/**
 * Unified model catalog for OpenRouter + other providers.
 * Categories: Free | Low-Cost | Efficient | Other (Perplexity, Gemini).
 * Used in Settings → Models and in dropdowns when user has set preferences.
 * IDs like "perplexity:sonar" mean provider=perplexity, model=sonar.
 */

export type ModelCategory = "free" | "low-cost" | "efficient" | "other";

export interface CatalogModel {
  id: string;
  label: string;
  category: ModelCategory;
  /** Brief hint for UI (e.g. "coding", "reasoning") */
  hint?: string;
}

// Free models (OpenRouter free tier)
const FREE: CatalogModel[] = [
  { id: "openrouter/free", label: "Free (auto-select)", category: "free" },
  { id: "qwen/qwen3-coder:free", label: "Qwen3 Coder 480B", category: "free", hint: "coding" },
  { id: "qwen/qwen-2.5-coder-32b-instruct:free", label: "Qwen2.5 Coder 32B", category: "free", hint: "coding" },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek Chat", category: "free" },
  { id: "deepseek/deepseek-r1-0528:free", label: "DeepSeek R1 0528", category: "free", hint: "reasoning" },
  { id: "deepseek/deepseek-r1-0528-qwen3-8b:free", label: "DeepSeek R1 Qwen3 8B", category: "free", hint: "reasoning" },
  { id: "arcee-ai/trinity-large-preview:free", label: "Arcee Trinity Large", category: "free", hint: "agentic" },
  { id: "arcee-ai/trinity-mini:free", label: "Arcee Trinity Mini", category: "free", hint: "agentic" },
  { id: "openrouter/aurora-alpha", label: "Aurora Alpha", category: "free", hint: "coding" },
  { id: "tngtech/deepseek-r1t2-chimera:free", label: "DeepSeek R1T2 Chimera", category: "free", hint: "reasoning" },
  { id: "tngtech/deepseek-r1t-chimera:free", label: "DeepSeek R1T Chimera", category: "free" },
  { id: "stepfun/step-3.5-flash:free", label: "StepFun Step 3.5 Flash", category: "free" },
  { id: "z-ai/glm-4.5-air:free", label: "GLM 4.5 Air", category: "free", hint: "agentic" },
  { id: "openai/gpt-oss-120b:free", label: "GPT OSS 120B", category: "free" },
  { id: "nvidia/nemotron-3-nano-30b-a3b:free", label: "NVIDIA Nemotron 3 Nano", category: "free" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B", category: "free" },
  { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B", category: "free" },
  { id: "upstage/solar-pro-3:free", label: "Solar Pro 3", category: "free" },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B Instruct", category: "free" },
];

// Low-cost models (paid but cheap – ~$0.15–0.60/M tokens)
const LOW_COST: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", category: "low-cost", hint: "fast, cheap" },
  { id: "anthropic/claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", category: "low-cost", hint: "fast" },
  { id: "anthropic/claude-3-haiku", label: "Claude 3 Haiku", category: "low-cost", hint: "cheap" },
  { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek Chat V3", category: "low-cost", hint: "coding" },
  { id: "deepseek/deepseek-coder-v2", label: "DeepSeek Coder V2", category: "low-cost", hint: "coding" },
  { id: "qwen/qwen-2.5-coder-7b-instruct", label: "Qwen 2.5 Coder 7B", category: "low-cost", hint: "coding" },
  { id: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash", category: "low-cost", hint: "fast" },
  { id: "google/gemini-2.0-flash-exp", label: "Gemini 2.0 Flash (exp)", category: "low-cost", hint: "fast" },
  { id: "meta-llama/llama-3.2-90b-vision-instruct", label: "Llama 3.2 90B Vision", category: "low-cost" },
  { id: "mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1 24B", category: "low-cost" },
];

// Efficient models (good balance of speed + quality for coding/planning)
const EFFICIENT: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", category: "efficient", hint: "fast" },
  { id: "anthropic/claude-3-5-haiku-latest", label: "Claude 3.5 Haiku", category: "efficient", hint: "fast" },
  { id: "google/gemini-2.0-flash", label: "Gemini 2.0 Flash", category: "efficient", hint: "fast" },
  { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek Chat V3", category: "efficient", hint: "coding" },
  { id: "deepseek/deepseek-coder-v2", label: "DeepSeek Coder V2", category: "efficient", hint: "coding" },
  { id: "qwen/qwen-2.5-coder-32b-instruct", label: "Qwen 2.5 Coder 32B", category: "efficient", hint: "coding" },
  { id: "meta-llama/llama-3.2-90b-vision-instruct", label: "Llama 3.2 90B Vision", category: "efficient" },
  { id: "anthropic/claude-3-5-sonnet", label: "Claude 3.5 Sonnet", category: "efficient", hint: "quality" },
  { id: "openai/gpt-4o", label: "GPT-4o", category: "efficient", hint: "quality" },
];

// Other providers (Perplexity, Gemini – select via provider+model)
const OTHER: CatalogModel[] = [
  { id: "perplexity:sonar", label: "Perplexity Sonar", category: "other", hint: "web-augmented" },
  { id: "perplexity:sonar-pro", label: "Perplexity Sonar Pro", category: "other", hint: "web-augmented" },
  { id: "gemini:gemini-2.0-flash", label: "Gemini 2.0 Flash", category: "other", hint: "free tier" },
  { id: "gemini:gemini-flash", label: "Gemini Flash", category: "other", hint: "free tier" },
];

/** All catalog models, deduplicated by id (first occurrence wins) */
const ALL_BY_ID = new Map<string, CatalogModel>();
for (const m of [...FREE, ...LOW_COST, ...EFFICIENT, ...OTHER]) {
  if (!ALL_BY_ID.has(m.id)) ALL_BY_ID.set(m.id, m);
}

export const MODEL_CATALOG = {
  free: FREE,
  "low-cost": LOW_COST,
  efficient: EFFICIENT,
  other: OTHER,
  all: Array.from(ALL_BY_ID.values()),
  byId: (id: string) => ALL_BY_ID.get(id),
} as const;

export const MAX_PREFERRED_MODELS = 10;
