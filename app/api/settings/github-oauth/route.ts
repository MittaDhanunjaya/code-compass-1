import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { encrypt } from "@/lib/encrypt";
import { getGitHubClientIdOnly } from "@/lib/github-oauth-config";

/**
 * GET /api/settings/github-oauth
 * Returns whether GitHub OAuth is configured and a masked client ID (never the secret).
 */
export async function GET(request: Request) {
  try {
    await requireAuth(request);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let clientId: string | null = null;
  try {
    clientId = await getGitHubClientIdOnly();
  } catch {
    // Table may not exist yet (migration not run)
  }
  const configured = !!clientId;
  const clientIdMasked = clientId
    ? `${clientId.slice(0, 6)}…${clientId.slice(-4)}`
    : null;

  return NextResponse.json({
    configured,
    clientIdMasked,
  });
}

/**
 * POST /api/settings/github-oauth
 * Set or clear GitHub OAuth client ID and secret (stored encrypted in DB).
 * Env vars still take precedence at runtime.
 */
export async function POST(request: Request) {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: { clientId?: string; clientSecret?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const clientSecret =
    typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";

  if (!clientId && !clientSecret) {
    const { error } = await supabase
      .from("github_oauth_config")
      .update({
        client_id: null,
        client_secret_encrypted: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, configured: false });
  }

  if (!clientId) {
    return NextResponse.json(
      { error: "Client ID is required when setting credentials" },
      { status: 400 }
    );
  }

  let clientSecretEncrypted: string;
  if (clientSecret) {
    clientSecretEncrypted = encrypt(clientSecret);
  } else {
    const { data: row } = await supabase
      .from("github_oauth_config")
      .select("client_secret_encrypted")
      .eq("id", 1)
      .single();
    if (!row?.client_secret_encrypted) {
      return NextResponse.json(
        { error: "Client secret is required when setting credentials for the first time" },
        { status: 400 }
      );
    }
    clientSecretEncrypted = row.client_secret_encrypted;
  }
  const { error } = await supabase
    .from("github_oauth_config")
    .upsert(
      {
        id: 1,
        client_id: clientId,
        client_secret_encrypted: clientSecretEncrypted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    configured: true,
    clientIdMasked: `${clientId.slice(0, 6)}…${clientId.slice(-4)}`,
  });
}
