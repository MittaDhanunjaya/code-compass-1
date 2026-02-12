import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { cloneRepo, cloneRepoWithToken, walkRepo, removeClone } from "@/lib/github-import";
import { decrypt } from "@/lib/encrypt";
import { logger } from "@/lib/logger";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/reimport-github
 * Re-clone the linked GitHub repo, clear workspace_files, and re-import.
 * Uses OAuth token for private repos. Keeps clone on disk for v2 sync.
 */
export async function POST(
  request: Request,
  { params }: RouteParams
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

  const { data: workspace, error: fetchError } = await supabase
    .from("workspaces")
    .select("id, github_repo_url, github_default_branch, github_owner, github_repo, github_is_private")
    .eq("id", workspaceId)
    .single();

  if (fetchError || !workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (!workspace.github_repo_url || !workspace.github_default_branch) {
    return NextResponse.json(
      { error: "Workspace is not linked to a GitHub repo" },
      { status: 400 }
    );
  }

  const { error: deleteError } = await supabase
    .from("workspace_files")
    .delete()
    .eq("workspace_id", workspaceId);

  if (deleteError) {
    return NextResponse.json(
      { error: deleteError.message },
      { status: 500 }
    );
  }

  let token: string | undefined;
  if (workspace.github_is_private && workspace.github_owner && workspace.github_repo) {
    const { data: gh } = await supabase
      .from("user_github")
      .select("github_access_token_encrypted")
      .eq("user_id", user.id)
      .single();
    if (gh?.github_access_token_encrypted) {
      try {
        token = decrypt(gh.github_access_token_encrypted);
      } catch {
        // fall back to public clone attempt
      }
    }
  }

  let repoRoot: string;
  let files: { path: string; content: string }[] = [];

  try {
    if (token && workspace.github_owner && workspace.github_repo) {
      repoRoot = await cloneRepoWithToken(
        workspaceId,
        workspace.github_owner,
        workspace.github_repo,
        workspace.github_default_branch,
        token
      );
    } else {
      repoRoot = await cloneRepo(
        workspaceId,
        workspace.github_repo_url,
        workspace.github_default_branch
      );
    }
    files = await walkRepo(repoRoot);
  } catch (e) {
    await removeClone(workspaceId).catch((err) => {
      logger.warn({ event: "remove_clone_failed", workspaceId, error: err instanceof Error ? err.message : String(err) });
    });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Clone failed" },
      { status: 500 }
    );
  }

  for (const f of files) {
    await supabase
      .from("workspace_files")
      .insert({
        workspace_id: workspaceId,
        path: f.path,
        content: f.content,
      });
  }

  // Keep clone on disk for v2 pull/push

  await supabase
    .from("workspaces")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", workspaceId)
    .eq("owner_id", user.id);

  return NextResponse.json({
    success: true,
    filesImported: files.length,
  });
}
