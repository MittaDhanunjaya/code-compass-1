import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import {
  getCloneRoot,
  cloneRepo,
  cloneRepoWithToken,
  pullRepo,
  walkRepo,
  removeClone,
} from "@/lib/github-import";
import { decrypt } from "@/lib/encrypt";
import { logger } from "@/lib/logger";
import { existsSync } from "fs";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/pull
 * Pull latest from origin into the workspace repo, then overwrite workspace_files (Option A).
 * Uses OAuth token for private repos. Keeps clone on disk for future push.
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

  const branch = workspace.github_default_branch;
  const cloneRoot = getCloneRoot(workspaceId);
  const repoExists = existsSync(cloneRoot);

  let token: string | undefined;
  if (workspace.github_is_private) {
    const { data: gh } = await supabase
      .from("user_github")
      .select("github_access_token_encrypted")
      .eq("user_id", user.id)
      .single();
    if (!gh?.github_access_token_encrypted) {
      return NextResponse.json(
        { error: "Connect GitHub in Settings to pull from a private repo" },
        { status: 400 }
      );
    }
    try {
      token = decrypt(gh.github_access_token_encrypted);
    } catch {
      return NextResponse.json(
        { error: "GitHub token invalid. Reconnect in Settings." },
        { status: 500 }
      );
    }
  }

  try {
    if (repoExists) {
      const authUrl =
        token && workspace.github_owner && workspace.github_repo
          ? `https://x-access-token:${encodeURIComponent(token)}@github.com/${workspace.github_owner}/${workspace.github_repo}.git`
          : undefined;
      await pullRepo(workspaceId, branch, authUrl);
    } else {
      if (token && workspace.github_owner && workspace.github_repo) {
        await cloneRepoWithToken(
          workspaceId,
          workspace.github_owner,
          workspace.github_repo,
          branch,
          token
        );
      } else {
        await cloneRepo(workspaceId, workspace.github_repo_url, branch);
      }
    }
  } catch (e) {
    if (!repoExists) {
      await removeClone(workspaceId).catch((err) => {
        logger.warn({ event: "remove_clone_failed", workspaceId, error: err instanceof Error ? err.message : String(err) });
      });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Pull failed" },
      { status: 500 }
    );
  }

  const repoRoot = getCloneRoot(workspaceId);
  const files = await walkRepo(repoRoot);

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

  for (const f of files) {
    await supabase.from("workspace_files").insert({
      workspace_id: workspaceId,
      path: f.path,
      content: f.content,
    });
  }

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
