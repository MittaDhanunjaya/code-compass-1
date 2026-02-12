import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/workspaces/[id]/index-status
 * Returns indexing status for the workspace (for file tree "Indexed N files" and progress).
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("indexing_status, indexing_progress, indexing_file_count")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (error || !workspace) {
    return NextResponse.json(
      { status: "idle", progress: 0, fileCount: 0 },
      { status: 200 }
    );
  }

  const status = (workspace as { indexing_status?: string }).indexing_status ?? "idle";
  const progress = (workspace as { indexing_progress?: number }).indexing_progress ?? 0;
  const fileCount = (workspace as { indexing_file_count?: number }).indexing_file_count ?? 0;

  return NextResponse.json({ status, progress, fileCount });
}
