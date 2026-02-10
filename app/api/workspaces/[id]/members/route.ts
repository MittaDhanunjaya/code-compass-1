import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/workspaces/[id]/members
 * Returns workspace owner and collaborators. Owner can change Safe Edit and providers; collaborators have access (future: role-based permissions).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Only owner or members can list (for now: owner or if user is in workspace_members)
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!isOwner && !membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
