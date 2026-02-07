import type { LLMProvider } from "./types";
import { openAIProvider } from "./openai-provider";
import { geminiProvider } from "./gemini-provider";
import { perplexityProvider } from "./perplexity-provider";
import { openRouterProvider } from "./openrouter-provider";

export const PROVIDERS = ["openrouter", "openai", "gemini", "perplexity"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter (many free models, incl. DeepSeek)",
  openai: "OpenAI (GPT) – paid",
  gemini: "Google Gemini – free tier, daily limits",
  perplexity: "Perplexity",
};

export const PROVIDER_KEYS_URL: Record<ProviderId, string> = {
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  perplexity: "https://www.perplexity.ai/settings/api",
};

// Free models available through OpenRouter. openrouter/free is a router that picks an available free model (most reliable).
export const OPENROUTER_FREE_MODELS = [
  { id: "openrouter/free", label: "Free (auto-select)" },
  { id: "deepseek/deepseek-chat-v3-0324:free", label: "DeepSeek Chat V3 (free)" },
  { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B (free)" },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B Instruct (free)" },
] as const;

export type OpenRouterModelId = (typeof OPENROUTER_FREE_MODELS)[number]["id"];

const providerMap: Record<ProviderId, LLMProvider> = {
  openrouter: openRouterProvider,
  openai: openAIProvider,
  gemini: geminiProvider,
  perplexity: perplexityProvider,
};

export function getProvider(id: ProviderId): LLMProvider {
  const provider = providerMap[id];
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/**
 * Return the model option to pass to the provider. Never pass an OpenRouter
 * model ID (e.g. deepseek/...) to non-OpenRouter providers.
 */
export function getModelForProvider(
  providerId: ProviderId,
  bodyModel?: string | null
): string | undefined {
  if (providerId === "openrouter") {
    const m = bodyModel?.trim();
    // Map deprecated or unavailable IDs to the free router (openrouter/free picks an available free model)
    if (!m || m === "deepseek/deepseek-coder:free" || m === "deepseek/deepseek-r1:free") return "openrouter/free";
    return m;
  }
  if (providerId === "openai") {
    const m = bodyModel?.trim();
    if (m && (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("gpt-4"))) return m;
    return undefined;
  }
  return undefined;
}
