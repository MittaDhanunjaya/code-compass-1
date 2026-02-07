import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getCloneRoot,
  syncWorkspaceFilesToRepo,
  commitAndPush,
} from "@/lib/github-import";
import { decrypt } from "@/lib/encrypt";
import { existsSync } from "fs";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/git/commit-push
 * Sync workspace_files to disk, commit all, push to current branch. Uses user's GitHub token.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const message = (body.message ?? "").trim() || "Update from AIForge";

  const { data: workspace, error: fetchError } = await supabase
    .from("workspaces")
    .select("id, github_owner, github_repo, github_current_branch, github_default_branch")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (fetchError || !workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (!workspace.github_owner || !workspace.github_repo) {
    return NextResponse.json(
      { error: "Workspace is not linked to a GitHub repo" },
      { status: 400 }
    );
  }

  const { data: gh } = await supabase
    .from("user_github")
    .select("github_access_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (!gh?.github_access_token_encrypted) {
    return NextResponse.json(
      { error: "Connect GitHub in Settings to push" },
      { status: 400 }
    );
  }

  let token: string;
  try {
    token = decrypt(gh.github_access_token_encrypted);
  } catch {
    return NextResponse.json(
      { error: "GitHub token invalid. Reconnect in Settings." },
      { status: 500 }
    );
  }

  const cloneRoot = getCloneRoot(workspaceId);
  if (!existsSync(cloneRoot)) {
    return NextResponse.json(
      { error: "Repo directory not found. Pull first." },
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

  const currentBranch = workspace.github_current_branch ?? "main";
  const defaultBranch = workspace.github_default_branch ?? "main";
  try {
    await commitAndPush(
      workspaceId,
      workspace.github_owner,
      workspace.github_repo,
      currentBranch,
      message,
      token
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Commit or push failed" },
      { status: 500 }
    );
  }

  const prUrl =
    currentBranch !== defaultBranch
      ? `https://github.com/${workspace.github_owner}/${workspace.github_repo}/compare/${currentBranch}?expand=1`
      : undefined;

  return NextResponse.json({
    success: true,
    branch: currentBranch,
    prUrl,
  });
}
