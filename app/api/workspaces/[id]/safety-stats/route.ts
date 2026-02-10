import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/workspaces/[id]/safety-stats
 * Returns aggregated safety-related stats for the workspace (sandbox runs, promoted, rolled back).
 * Use for a simple safety dashboard; guardrail/blocked counts can be added when we persist them.
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
    .select("id, owner_id")
    .eq("id", workspaceId)
    .single();

  if (wsError || !workspace || (workspace as { owner_id: string }).owner_id !== user.id) {
    return NextResponse.json({ error: "Forbidden or not found" }, { status: 404 });
  }

  const { data: runs, error } = await supabase
    .from("sandbox_runs")
    .select("id, source, sandbox_checks_passed, promoted_at, user_rolled_back, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const list = runs ?? [];
  const bySource: Record<string, { total: number; promoted: number; checksPassed: number; rolledBack: number }> = {};
  let totalRuns = 0;
  let totalPromoted = 0;
  let totalChecksPassed = 0;
  let totalRolledBack = 0;

  for (const r of list) {
    const src = r.source ?? "agent";
    if (!bySource[src]) {
      bySource[src] = { total: 0, promoted: 0, checksPassed: 0, rolledBack: 0 };
    }
    bySource[src].total += 1;
    totalRuns += 1;
    if (r.promoted_at) {
      bySource[src].promoted += 1;
      totalPromoted += 1;
    }
    if (r.sandbox_checks_passed === true) {
      bySource[src].checksPassed += 1;
      totalChecksPassed += 1;
    }
    const rolledBack = (r as { user_rolled_back?: boolean }).user_rolled_back === true;
    if (rolledBack) {
      bySource[src].rolledBack += 1;
      totalRolledBack += 1;
    }
  }

  return NextResponse.json({
    workspaceId,
    totalRuns,
    totalPromoted,
    totalChecksPassed,
    totalRolledBack,
    bySource,
  });
}
