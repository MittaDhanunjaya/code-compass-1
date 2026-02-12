import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { executeCommandInWorkspace } from "@/lib/agent/execute-command-server";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { validateToolInput, acquireToolSlot, releaseToolSlot } from "@/services/tools/registry";

export async function POST(request: Request) {
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
  try {
    validateToolInput<{ command: string }>("run_command", { command });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid command";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  try {
    acquireToolSlot(user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Tool execution limit reached";
    return NextResponse.json({ error: msg }, { status: 429 });
  }

  try {
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
  } finally {
    releaseToolSlot(user.id);
  }
}
