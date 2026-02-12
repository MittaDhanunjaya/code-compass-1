import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { encrypt } from "@/lib/encrypt";

/**
 * POST /api/models/user
 * Body: { modelId: string, apiKey?: string, aliasLabel?: string }
 * Creates or updates user_models: encrypts apiKey if provided, sets alias.
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

  let body: { modelId?: string; apiKey?: string; aliasLabel?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const modelId = (body.modelId ?? "").trim();
  if (!modelId) {
    return NextResponse.json({ error: "modelId is required" }, { status: 400 });
  }

  const { data: model } = await supabase
    .from("models")
    .select("id")
    .eq("id", modelId)
    .single();
  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  let apiKeyEncrypted: string | null = null;
  if (body.apiKey != null && String(body.apiKey).trim()) {
    try {
      apiKeyEncrypted = encrypt(String(body.apiKey).trim());
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Encryption failed" },
        { status: 500 }
      );
    }
  }

  const aliasLabel = body.aliasLabel != null ? String(body.aliasLabel).trim() || null : null;

  const payload: Record<string, unknown> = {
    user_id: user.id,
    model_id: modelId,
    alias_label: aliasLabel ?? undefined,
    enabled: true,
    updated_at: new Date().toISOString(),
  };
  if (apiKeyEncrypted != null) payload.api_key_encrypted = apiKeyEncrypted;

  const { data: row, error } = await supabase
    .from("user_models")
    .upsert(payload, { onConflict: "user_id,model_id" })
    .select("id, model_id, enabled, alias_label")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    id: row.id,
    modelId: row.model_id,
    aliasLabel: row.alias_label ?? undefined,
    enabled: row.enabled,
  });
}
