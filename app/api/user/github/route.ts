import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/user/github
 * Returns GitHub link status for the current user (no token).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
