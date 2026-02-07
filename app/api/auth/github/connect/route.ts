import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
