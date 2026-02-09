/**
 * Helper to check which providers have API keys configured.
 * Used to show helpful UI hints and auto-select available providers.
 */

import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import type { ProviderId } from "@/lib/llm/providers";
import { PROVIDERS } from "@/lib/llm/providers";

export async function getAvailableProviders(userId: string): Promise<Set<ProviderId>> {
  const supabase = await createClient();
  const available = new Set<ProviderId>();

  for (const provider of PROVIDERS) {
    const { data: keyRow } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", userId)
      .eq("provider", provider)
      .single();

    if (keyRow?.key_encrypted) {
      try {
        decrypt(keyRow.key_encrypted);
        available.add(provider);
      } catch {
        // Invalid key, skip
      }
    }
  }

  return available;
}

export async function getFirstAvailableProvider(userId: string): Promise<ProviderId | null> {
  const available = await getAvailableProviders(userId);
  
  // Prefer OpenRouter (free models), then OpenAI, then Gemini, then others
  const priority: ProviderId[] = ["openrouter", "openai", "gemini", "perplexity"];
  
  for (const provider of priority) {
    if (available.has(provider)) {
      return provider;
    }
  }
  
  // Return first available if none in priority list
  return available.size > 0 ? Array.from(available)[0] : null;
}
