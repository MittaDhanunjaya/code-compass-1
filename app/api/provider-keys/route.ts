import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/encrypt";

/**
 * GET /api/provider-keys?provider=openai
 * Returns { configured: boolean } - never returns the actual key
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");
  if (!provider) {
    return NextResponse.json(
      { error: "provider query param required" },
      { status: 400 }
    );
  }

  const { data } = await supabase
    .from("provider_keys")
    .select("id")
    .eq("user_id", user.id)
    .eq("provider", provider)
    .single();

  return NextResponse.json({ configured: !!data });
}

/**
 * POST /api/provider-keys
 * Body: { provider: string, apiKey: string }
 * Stores encrypted key. Key is never returned.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
