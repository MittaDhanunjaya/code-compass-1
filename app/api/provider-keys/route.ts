import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { encrypt } from "@/lib/encrypt";

/**
 * GET /api/provider-keys?provider=openai
 * Returns { configured: boolean } - never returns the actual key
 */
export async function GET(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");
  if (!provider) {
    return NextResponse.json(
      { error: "provider query param required" },
      { status: 400 }
    );
  }

  const { data: keyRow, error } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", user.id)
    .eq("provider", provider)
    .maybeSingle(); // Use maybeSingle() to avoid throwing on no rows

  if (error) {
    console.error(`Error checking key for ${provider}:`, error);
    return NextResponse.json({ configured: false, error: error.message });
  }

  if (!keyRow?.key_encrypted) {
    return NextResponse.json({ configured: false });
  }

  // Check if we can decrypt the key (to detect encryption key mismatch)
  let canDecrypt = false;
  try {
    const { decrypt } = await import("@/lib/encrypt");
    decrypt(keyRow.key_encrypted);
    canDecrypt = true;
  } catch {
    // Decryption failed - likely encryption key mismatch
    canDecrypt = false;
  }

  return NextResponse.json({ 
    configured: true,
    canDecrypt,
    needsReentry: !canDecrypt // Flag to indicate key needs to be re-entered
  });
}

/**
 * POST /api/provider-keys
 * Body: { provider: string, apiKey: string }
 * Stores encrypted key. Key is never returned.
 */
export async function POST(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: { provider?: string; apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const provider = (body.provider ?? "").trim();
  const apiKey = (body.apiKey ?? "").trim();
  if (!provider || !apiKey) {
    return NextResponse.json(
      { error: "provider and apiKey are required" },
      { status: 400 }
    );
  }

  let keyEncrypted: string;
  try {
    keyEncrypted = encrypt(apiKey);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "Encryption failed. Ensure ENCRYPTION_KEY is set in .env.local.",
      },
      { status: 500 }
    );
  }

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

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/provider-keys?provider=openai
 */
export async function DELETE(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");
  if (!provider) {
    return NextResponse.json(
      { error: "provider query param required" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("provider_keys")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", provider);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
