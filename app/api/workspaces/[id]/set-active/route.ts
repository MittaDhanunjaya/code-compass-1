import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { setActiveWorkspaceIdForUser } from "@/lib/workspaces/active-workspace";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/set-active
 * Sets the current user's active workspace. Auth required; enforces workspace access.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  let user: { id: string };
  try {
    const auth = await requireWorkspaceAccess(request, workspaceId, supabase);
    user = auth.user;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }
  const trimmed = (workspaceId ?? "").trim();
  if (!trimmed) {
    return NextResponse.json({ error: "Workspace id is required" }, { status: 400 });
  }

  try {
    await setActiveWorkspaceIdForUser(supabase, user.id, trimmed);
    return NextResponse.json({ activeWorkspaceId: trimmed });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to set active workspace";
    if (message.includes("not found") || message.includes("access denied")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
