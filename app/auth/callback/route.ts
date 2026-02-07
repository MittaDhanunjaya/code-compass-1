import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/encrypt";

/**
 * Handles the redirect from Supabase after email confirmation (or OAuth).
 * Exchanges the authorization code for a session and redirects to the app.
 * When the session has a GitHub provider_token, persists it to user_github (encrypted).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/app";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session?.user) {
      const session = data.session as { provider_token?: string; user: { id: string; user_metadata?: Record<string, unknown> } };
      if (session.provider_token) {
        try {
          const meta = session.user.user_metadata ?? {};
          const githubUserId = String(meta.sub ?? meta.provider_id ?? session.user.id);
          const githubUsername = String(meta.user_name ?? meta.login ?? meta.full_name ?? "github");
          const githubAvatarUrl = typeof meta.avatar_url === "string" ? meta.avatar_url : null;
          await supabase.from("user_github").upsert(
            {
              user_id: session.user.id,
              github_user_id: githubUserId,
              github_username: githubUsername,
              github_avatar_url: githubAvatarUrl,
              github_access_token_encrypted: encrypt(session.provider_token),
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" }
          );
        } catch {
          // Non-fatal: session is still valid; token persist can be retried from settings
        }
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth_callback_error`);
}
