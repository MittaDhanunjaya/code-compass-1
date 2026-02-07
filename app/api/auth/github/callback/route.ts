import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/encrypt";
import { getGitHubOAuthConfig } from "@/lib/github-oauth-config";

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const origin = () => {
  if (typeof process.env.VERCEL_URL !== "undefined") {
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
};

/**
 * GET /api/auth/github/callback
 * GitHub OAuth callback for "Connect GitHub". Exchanges code for token,
 * saves encrypted token to user_github, redirects to settings. Token never sent to frontend.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(
      `${origin()}/app/settings?github=error&message=missing_params`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(
      `${origin()}/sign-in?next=/app/settings&github=error`
    );
  }

  const { data: stateRow, error: stateError } = await supabase
    .from("github_oauth_state")
    .select("user_id")
    .eq("state", state)
    .eq("user_id", user.id)
    .single();

  if (stateError || !stateRow) {
    return NextResponse.redirect(
      `${origin()}/app/settings?github=error&message=invalid_state`
    );
  }

  await supabase.from("github_oauth_state").delete().eq("state", state);

  const config = await getGitHubOAuthConfig();
  if (!config?.clientId || !config?.clientSecret) {
    return NextResponse.redirect(
      `${origin()}/app/settings?github=error&message=config`
    );
  }
  const { clientId, clientSecret } = config;

  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${origin()}/api/auth/github/callback`,
    }),
  });
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    return NextResponse.redirect(
      `${origin()}/app/settings?github=error&message=token`
    );
  }

  const userRes = await fetch(GITHUB_USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const githubUser = (await userRes.json()) as {
    id?: number;
    login?: string;
    avatar_url?: string;
  };
  const githubUserId = String(githubUser.id ?? "");
  const githubUsername = githubUser.login ?? "github";
  const githubAvatarUrl = githubUser.avatar_url ?? null;

  const { error: upsertError } = await supabase.from("user_github").upsert(
    {
      user_id: stateRow.user_id,
      github_user_id: githubUserId,
      github_username: githubUsername,
      github_avatar_url: githubAvatarUrl,
      github_access_token_encrypted: encrypt(accessToken),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (upsertError) {
    return NextResponse.redirect(
      `${origin()}/app/settings?github=error&message=save`
    );
  }

  return NextResponse.redirect(`${origin()}/app/settings?github=connected`);
}
