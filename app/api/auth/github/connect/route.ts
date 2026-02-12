import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { getGitHubOAuthConfig } from "@/lib/github-oauth-config";
import { randomBytes } from "crypto";

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const SCOPES = "repo,read:user";

const baseUrl = () =>
  typeof process.env.VERCEL_URL !== "undefined"
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/**
 * GET /api/auth/github/connect
 * Starts "Connect GitHub" flow: store state -> user_id, redirect to GitHub.
 * User must be logged in. OAuth credentials from env or DB (Settings UI).
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

  const config = await getGitHubOAuthConfig();
  if (!config?.clientId) {
    return NextResponse.redirect(
      `${baseUrl()}/app/settings?github=error&message=not_configured`
    );
  }
  const clientId = config.clientId;

  const state = randomBytes(16).toString("hex");
  const { error } = await supabase.from("github_oauth_state").insert({
    state,
    user_id: user.id,
  });
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  const redirectUri = `${baseUrl()}/api/auth/github/callback`;
  const url = new URL(GITHUB_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${redirectUri}/api/auth/github/callback`);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
