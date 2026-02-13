import type { LLMProvider } from "./types";
import { openAIProvider } from "./openai-provider";
import { geminiProvider } from "./gemini-provider";
import { perplexityProvider } from "./perplexity-provider";
import { openRouterProvider } from "./openrouter-provider";
import { ollamaProvider } from "./ollama-provider";
import { lmstudioProvider } from "./lmstudio-provider";
import { OPENROUTER_FREE_MODELS } from "./openrouter-models";

export { OPENROUTER_FREE_MODELS } from "./openrouter-models";
export type { OpenRouterModelId } from "./openrouter-models";

export const PROVIDERS = ["openrouter", "openai", "gemini", "perplexity", "ollama", "lmstudio"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter (many free models, incl. DeepSeek)",
  openai: "OpenAI (GPT) – paid",
  gemini: "Google Gemini – free tier, daily limits",
  perplexity: "Perplexity",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
};

export const PROVIDER_KEYS_URL: Record<ProviderId, string> = {
  openrouter: "https://openrouter.ai/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  perplexity: "https://www.perplexity.ai/settings/api",
  ollama: "",
  lmstudio: "",
};

const providerMap: Record<ProviderId, LLMProvider> = {
  openrouter: openRouterProvider,
  openai: openAIProvider,
  gemini: geminiProvider,
  perplexity: perplexityProvider,
  ollama: ollamaProvider,
  lmstudio: lmstudioProvider,
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
    const knownFreeIds = OPENROUTER_FREE_MODELS.map((x) => x.id);
    // Pass through when user selected a known free model (so they actually get that model)
    if (m && knownFreeIds.includes(m as (typeof knownFreeIds)[number])) return m;
    // Route unknown :free or empty to openrouter/free for robustness
    if (!m || m.endsWith(":free")) return "openrouter/free";
    return m;
  }
  if (providerId === "openai") {
    const m = bodyModel?.trim();
    if (m && (m.startsWith("gpt-") || m.startsWith("o1-") || m.startsWith("gpt-4"))) return m;
    return undefined;
  }
  if (providerId === "perplexity") {
    const m = bodyModel?.trim();
    if (m && (m === "sonar" || m === "sonar-pro")) return m;
    return undefined;
  }
  if (providerId === "gemini") {
    const m = bodyModel?.trim();
    if (m && (m.startsWith("gemini-") || m.startsWith("gemini/"))) return m;
    return undefined;
  }
  if (providerId === "ollama") {
    const m = bodyModel?.trim();
    return m || undefined;
  }
  if (providerId === "lmstudio") {
    const m = bodyModel?.trim();
    return m || "local";
  }
  return undefined;
}
