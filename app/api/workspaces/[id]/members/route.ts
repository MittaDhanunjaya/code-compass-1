import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";

/**
 * GET /api/workspaces/[id]/members
 * Returns workspace owner and collaborators. Owner can change Safe Edit and providers; collaborators have access (future: role-based permissions).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, owner_id, name")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const ownerId = (workspace as { owner_id: string }).owner_id;
  const isOwner = ownerId === user.id;

  const { data: members } = await supabase
    .from("workspace_members")
    .select("user_id, role, created_at")
    .eq("workspace_id", workspaceId);

  const collaborators = (members ?? []).map((m) => ({
    userId: m.user_id,
    role: (m as { role: string }).role,
    joinedAt: (m as { created_at: string }).created_at,
  }));

  return NextResponse.json({
    workspaceId,
    ownerId,
    isOwner,
    collaborators,
    note: "Only the owner can toggle Safe Edit and add or change model providers. Collaborators have read/write to the workspace.",
  });
}
