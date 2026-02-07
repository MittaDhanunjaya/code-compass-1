import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCloneRoot, syncWorkspaceFilesToRepo, getGitStatus } from "@/lib/github-import";
import { existsSync } from "fs";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/workspaces/[id]/git/status
 * Syncs workspace_files to disk, then returns git status (modified/added/deleted).
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace, error: fetchError } = await supabase
    .from("workspaces")
    .select("id, github_owner, github_repo, github_current_branch")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (fetchError || !workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const cloneRoot = getCloneRoot(workspaceId);
  if (!existsSync(cloneRoot)) {
    return NextResponse.json(
      { error: "Repo directory not found. Pull or create workspace from GitHub first." },
      { status: 400 }
    );
  }

  const { data: files } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  if (files?.length) {
    await syncWorkspaceFilesToRepo(workspaceId, files);
  }

  const entries = await getGitStatus(workspaceId);
  return NextResponse.json({
    currentBranch: workspace.github_current_branch ?? "main",
    entries,
  });
}
