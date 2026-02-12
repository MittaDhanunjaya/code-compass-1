/**
 * Utility endpoint to help reset API keys when encryption key changes
 * POST /api/debug/reset-keys
 * Body: { provider: string, apiKey: string }
 *
 * This will re-encrypt and save the key with the current ENCRYPTION_KEY
 *
 * RESTRICTIONS: Blocked in production. Requires admin role. Never logs the apiKey.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/encrypt";
import { isAdmin } from "@/lib/auth/admin";
import type { ProviderId } from "@/lib/llm/providers";

export async function POST(request: Request) {
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

  let body: { provider?: string; apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = (body.provider ?? "").trim() as ProviderId;
  const apiKey = (body.apiKey ?? "").trim();

  if (!provider || !apiKey) {
    return NextResponse.json(
      { error: "provider and apiKey are required" },
      { status: 400 }
    );
  }

  try {
    const keyEncrypted = encrypt(apiKey);

    const { error } = await supabase.from("provider_keys").upsert(
      {
        user_id: user.id,
        provider,
        key_encrypted: keyEncrypted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,provider" }
    );

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: `Key for ${provider} has been re-encrypted and saved successfully.`,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Encryption failed. Check ENCRYPTION_KEY in .env.local.",
      },
      { status: 500 }
    );
  }
}
