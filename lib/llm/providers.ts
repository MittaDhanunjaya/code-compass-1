import type { LLMProvider } from "./types";
import { openAIProvider } from "./openai-provider";
import { geminiProvider } from "./gemini-provider";
import { perplexityProvider } from "./perplexity-provider";
import { openRouterProvider } from "./openrouter-provider";
import { ollamaProvider } from "./ollama-provider";

export const PROVIDERS = ["openrouter", "openai", "gemini", "perplexity", "ollama"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter (many free models, incl. DeepSeek)",
  openai: "OpenAI (GPT) – paid",
  gemini: "Google Gemini – free tier, daily limits",
  perplexity: "Perplexity",
  ollama: "Ollama (local)",
};

export const PROVIDER_KEYS_URL: Record<ProviderId, string> = {
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  perplexity: "https://www.perplexity.ai/settings/api",
  ollama: "",
};

// Free models available through OpenRouter. openrouter/free is a router that picks an available free model (most reliable).
// Note: Some :free variant IDs may 404; getModelForProvider maps them to openrouter/free.
export const OPENROUTER_FREE_MODELS = [
  { id: "openrouter/free", label: "Free (auto-select)" },
  { id: "deepseek/deepseek-chat:free", label: "DeepSeek Chat (free)" },
  { id: "meta-llama/llama-3.2-3b-instruct:free", label: "Llama 3.2 3B (free)" },
  { id: "mistralai/mistral-7b-instruct:free", label: "Mistral 7B Instruct (free)" },
] as const;

export type OpenRouterModelId = (typeof OPENROUTER_FREE_MODELS)[number]["id"];

const providerMap: Record<ProviderId, LLMProvider> = {
  openrouter: openRouterProvider,
  openai: openAIProvider,
  gemini: geminiProvider,
  perplexity: perplexityProvider,
  ollama: ollamaProvider,
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
    // Route all :free model IDs through openrouter/free so we never 404 when OpenRouter changes endpoints
    if (!m || m.endsWith(":free")) return "openrouter/free";
    return m;
  }
  if (providerId === "openai") {
    const m = bodyModel?.trim();
    if (m && (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("gpt-4"))) return m;
    return undefined;
  }
  if (providerId === "ollama") {
    const m = bodyModel?.trim();
    return m || undefined;
  }
  return undefined;
}
