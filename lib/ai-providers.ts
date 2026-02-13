/**
 * AI provider fallback config: quota/rate-limit safe routing.
 * Env-based enable/disable. Defines fallback chain for 429/quota/rate-limit.
 */

import type { ProviderId } from "./llm/providers";

/** Fallback order: OpenAI (paid) → OpenRouter free → Gemini free → local last. */
export const PREFERRED_FALLBACK_ORDER: ProviderId[] = [
  "openai",
  "openrouter",
  "gemini",
  "perplexity",
  "ollama",
  "lmstudio",
];

/** @deprecated Use PREFERRED_FALLBACK_ORDER. Kept for compatibility. */
export const FALLBACK_CHAIN: ProviderId[] = PREFERRED_FALLBACK_ORDER;

/** Env-based enable. Set AI_PROVIDERS_ENABLED=false to disable. */
export function isAiEnabled(): boolean {
  const v = process.env.AI_PROVIDERS_ENABLED;
  if (v === "false" || v === "0") return false;
  return true;
}

/** Get fallback chain up to and including given provider. */
export function getFallbackChainUpTo(primary: ProviderId): ProviderId[] {
  const idx = PREFERRED_FALLBACK_ORDER.indexOf(primary);
  if (idx === -1) return [primary, ...PREFERRED_FALLBACK_ORDER];
  return PREFERRED_FALLBACK_ORDER.slice(idx);
}

/**
 * Reorder provider keys by preferred fallback: OpenAI > OpenRouter > Gemini > rest.
 * Only includes providers that are in the input list.
 */
export function orderProviderKeysByPreference<T extends { providerId: ProviderId }>(
  keys: T[]
): T[] {
  const byProvider = new Map(keys.map((k) => [k.providerId, k]));
  const result: T[] = [];
  for (const p of PREFERRED_FALLBACK_ORDER) {
    const k = byProvider.get(p);
    if (k) result.push(k);
  }
  for (const k of keys) {
    if (!result.includes(k)) result.push(k);
  }
  return result;
}
