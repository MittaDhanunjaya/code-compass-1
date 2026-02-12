import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { executeCommandInWorkspace } from "@/lib/agent/execute-command-server";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";

export async function POST(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth();
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: { workspaceId?: string; command?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const command = (body.command ?? "").trim();
  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);

  if (!workspaceId || !command) {
    return NextResponse.json(
      { error: !workspaceId ? "No active workspace selected" : "command is required" },
      { status: 400 }
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const result = await executeCommandInWorkspace(supabase, workspaceId, command, request.signal);
  return NextResponse.json(result);
}
