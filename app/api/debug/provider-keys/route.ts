/**
 * Debug endpoint to check API key status
 * GET /api/debug/provider-keys
 * Returns which providers have keys configured (without exposing the keys)
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, {
    configured: boolean;
    hasKey: boolean;
    canDecrypt: boolean;
    error?: string;
  }> = {};

  for (const provider of PROVIDERS) {
    const { data: keyRow, error } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", user.id)
      .eq("provider", provider)
      .maybeSingle();

    if (error) {
      results[provider] = {
        configured: false,
        hasKey: false,
        canDecrypt: false,
        error: error.message,
      };
      continue;
    }

    if (!keyRow?.key_encrypted) {
      results[provider] = {
        configured: false,
        hasKey: false,
        canDecrypt: false,
      };
      continue;
    }

    let canDecrypt = false;
    let decryptError: string | undefined;
    try {
      decrypt(keyRow.key_encrypted);
      canDecrypt = true;
    } catch (e) {
      decryptError = e instanceof Error ? e.message : String(e);
    }

    results[provider] = {
      configured: true,
      hasKey: true,
      canDecrypt,
      error: decryptError,
    };
  }

  return NextResponse.json({
    userId: user.id,
    encryptionKeySet: !!process.env.ENCRYPTION_KEY,
    encryptionKeyLength: process.env.ENCRYPTION_KEY?.length || 0,
    providers: results,
  });
}
