import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { getActiveWorkspaceIdForUser } from "@/lib/workspaces/active-workspace";

/**
 * GET /api/workspaces/active
 * Returns the current user's active workspace id, or null if none set.
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

  try {
    const activeWorkspaceId = await getActiveWorkspaceIdForUser(supabase, user.id);
    return NextResponse.json({ activeWorkspaceId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to get active workspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
