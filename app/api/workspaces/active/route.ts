import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspaceIdForUser } from "@/lib/workspaces/active-workspace";

/**
 * GET /api/workspaces/active
 * Returns the current user's active workspace id, or null if none set.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const activeWorkspaceId = await getActiveWorkspaceIdForUser(supabase, user.id);
    return NextResponse.json({ activeWorkspaceId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to get active workspace";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
