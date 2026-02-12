import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { getCloneRoot, createBranchFromDefault } from "@/lib/github-import";
import { decrypt } from "@/lib/encrypt";
import { existsSync } from "fs";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST /api/workspaces/[id]/git/create-branch
 * Create a new branch from default, push --set-upstream, update workspace.github_current_branch.
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

  let body: { branchName?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const branchName = (body.branchName ?? "").trim();
  if (!branchName) {
    return NextResponse.json(
      { error: "branchName is required" },
      { status: 400 }
    );
  }

  const { data: workspace, error: fetchError } = await supabase
    .from("workspaces")
    .select("id, github_owner, github_repo, github_default_branch")
    .eq("id", workspaceId)
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
      { error: "Connect GitHub in Settings to create a branch" },
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

  const defaultBranch = workspace.github_default_branch ?? "main";
  try {
    await createBranchFromDefault(
      workspaceId,
      branchName,
      defaultBranch,
      workspace.github_owner,
      workspace.github_repo,
      token
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Create branch failed" },
      { status: 500 }
    );
  }

  await supabase
    .from("workspaces")
    .update({
      github_current_branch: branchName,
      updated_at: new Date().toISOString(),
    })
    .eq("id", workspaceId)
    .eq("owner_id", user.id);

  return NextResponse.json({
    success: true,
    branch: branchName,
  });
}
