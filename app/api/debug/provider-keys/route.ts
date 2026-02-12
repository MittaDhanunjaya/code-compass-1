/**
 * Debug endpoint to check API key status
 * GET /api/debug/provider-keys
 * Returns which providers have keys configured (without exposing the keys)
 *
 * RESTRICTIONS: Blocked in production. Requires admin role. Never returns or logs secrets.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { isAdmin } from "@/lib/auth/admin";
import { PROVIDERS } from "@/lib/llm/providers";

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAdmin(user.id)) {
    return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 });
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
    } catch {
      decryptError = "decrypt failed";
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
    encryptionKeyLength: process.env.ENCRYPTION_KEY?.length ?? 0,
    providers: results,
  });
}
