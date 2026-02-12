import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";

/**
 * GET /api/user/github
 * Returns GitHub link status for the current user (no token).
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

  const { data, error } = await supabase
    .from("user_github")
    .select("github_username, github_avatar_url")
    .eq("user_id", user.id)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return NextResponse.json({ linked: false, username: null, avatarUrl: null });
    }
    if (error.message?.includes("does not exist")) {
      return NextResponse.json({ linked: false, username: null, avatarUrl: null });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    linked: true,
    username: data.github_username ?? null,
    avatarUrl: data.github_avatar_url ?? null,
  });
}
