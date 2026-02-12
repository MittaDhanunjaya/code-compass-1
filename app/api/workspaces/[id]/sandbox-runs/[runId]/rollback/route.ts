import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";

type RouteParams = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/workspaces/[id]/sandbox-runs/[runId]/rollback
 * Mark this sandbox run as user_rolled_back (user rejected or reverted changes).
 * Used for evaluation: "where the agent tends to fail" and refinement.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId, runId } = await params;
  const supabase = await createClient();
  let user: { id: string };
  try {
    const auth = await requireAuth(request);
    user = auth.user;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { data: run } = await supabase
    .from("sandbox_runs")
    .select("id, workspace_id, user_id")
    .eq("id", runId)
    .eq("user_id", user.id)
    .single();

  if (!run) {
    return NextResponse.json({ error: "Sandbox run not found" }, { status: 404 });
  }
  if (run.workspace_id !== workspaceId) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 400 });
  }

  const { error } = await supabase
    .from("sandbox_runs")
    .update({ user_rolled_back: true })
    .eq("id", runId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
