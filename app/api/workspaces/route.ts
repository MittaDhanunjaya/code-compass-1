import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cloneRepo, cloneRepoWithToken, walkRepo, removeClone } from "@/lib/github-import";
import { decrypt } from "@/lib/encrypt";

function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Select minimal columns that definitely exist, then add defaults
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  // Add defaults for columns that might not exist yet (from migrations)
  const workspacesWithDefaults = (data ?? []).map((w: any) => ({
    ...w,
    safe_edit_mode: true,
    github_repo_url: null,
    github_default_branch: null,
    github_owner: null,
    github_repo: null,
    github_is_private: null,
    github_current_branch: null,
  }));

  return NextResponse.json(workspacesWithDefaults);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name?: string;
    githubRepoUrl?: string;
    githubBranch?: string;
    fromMyRepo?: { owner: string; repo: string; defaultBranch: string; isPrivate: boolean };
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const name = body.name?.trim() || "Untitled Workspace";
  const fromMyRepo = body.fromMyRepo;
  const githubRepoUrl = body.githubRepoUrl?.trim();
  const githubBranch = (body.githubBranch?.trim() || "main").replace(/^\s+|\s+$/g, "") || "main";

  // Insert workspace first
  const { data: inserted, error: insertError } = await supabase
    .from("workspaces")
    .insert({ owner_id: user.id, name })
    .select("id")
    .single();

  if (insertError || !inserted) {
    return NextResponse.json(
      { error: insertError?.message || "Failed to create workspace" },
      { status: 500 }
    );
  }

  // Select workspace - start with minimal columns that definitely exist, then add defaults
  // This handles cases where migrations haven't been run yet
  const { data: workspaceData, error: selectError } = await supabase
    .from("workspaces")
    .select("id, name, created_at, updated_at")
    .eq("id", inserted.id)
    .single();

  if (selectError || !workspaceData) {
    return NextResponse.json(
      { error: selectError?.message || "Failed to fetch created workspace" },
      { status: 500 }
    );
  }

  // Add defaults for columns that might not exist yet (from migrations)
  const workspace = {
    ...workspaceData,
    safe_edit_mode: true, // Default value
    github_repo_url: null,
    github_default_branch: null,
    github_owner: null,
    github_repo: null,
    github_is_private: null,
    github_current_branch: null,
  };

  if (!githubRepoUrl && !fromMyRepo) {
    return NextResponse.json(workspace);
  }

  let repoRoot: string;
  let files: { path: string; content: string }[] = [];
  let repoUrl: string;
  let owner: string;
  let repo: string;
  let isPrivate: boolean;
  const branch = fromMyRepo ? (fromMyRepo.defaultBranch || "main") : githubBranch;

  if (fromMyRepo) {
    owner = fromMyRepo.owner.trim();
    repo = fromMyRepo.repo.trim();
    if (!owner || !repo) {
      return NextResponse.json(
        { error: "fromMyRepo requires owner and repo" },
        { status: 400 }
      );
    }
    repoUrl = `https://github.com/${owner}/${repo}`;
    isPrivate = !!fromMyRepo.isPrivate;
    const { data: gh } = await supabase
      .from("user_github")
      .select("github_access_token_encrypted")
      .eq("user_id", user.id)
      .single();
    if (!gh?.github_access_token_encrypted) {
      return NextResponse.json(
        { error: "Connect GitHub in Settings to create a workspace from your repos" },
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
    try {
      repoRoot = await cloneRepoWithToken(workspace.id, owner, repo, branch, token);
      files = await walkRepo(repoRoot);
    } catch (e) {
      await removeClone(workspace.id).catch(() => {});
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Clone failed" },
        { status: 500 }
      );
    }
  } else {
    const normalized = normalizeRepoUrl(githubRepoUrl!);
    if (!normalized.includes("github.com")) {
      return NextResponse.json(
        { error: "Invalid GitHub repo URL" },
        { status: 400 }
      );
    }
    const parsed = parseOwnerRepo(normalized);
    owner = parsed?.owner ?? "";
    repo = parsed?.repo ?? "";
    isPrivate = false;
    repoUrl = normalized;
    try {
      repoRoot = await cloneRepo(workspace.id, repoUrl, branch);
      files = await walkRepo(repoRoot);
    } catch (e) {
      await removeClone(workspace.id).catch(() => {});
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Clone failed" },
        { status: 500 }
      );
    }
  }

  for (const f of files) {
    await supabase
      .from("workspace_files")
      .insert({
        workspace_id: workspace.id,
        path: f.path,
        content: f.content,
      });
  }

  // Keep clone on disk for v2 sync (pull/push)
  const updateData: any = {
    github_repo_url: repoUrl,
    github_default_branch: branch,
    github_owner: owner || null,
    github_repo: repo || null,
    github_is_private: isPrivate,
    updated_at: new Date().toISOString(),
  };
  
  // Only include github_current_branch if column exists (will be set by migration)
  // For now, try to update it - if it fails, that's okay, we'll select without it
  updateData.github_current_branch = branch;
  
  const updateResult = await supabase
    .from("workspaces")
    .update(updateData)
    .eq("id", workspace.id)
    .select(selectWithBranch)
    .single();
  
  let updated = updateResult.data;
  if (updateResult.error && updateResult.error.message?.includes("github_current_branch")) {
    // Column doesn't exist, update without it and select without it
    delete updateData.github_current_branch;
    await supabase
      .from("workspaces")
      .update(updateData)
      .eq("id", workspace.id);
    const retry = await supabase
      .from("workspaces")
      .select(selectWithoutBranch)
      .eq("id", workspace.id)
      .single();
    updated = retry.data;
    if (updated) {
      updated.github_current_branch = branch; // Set in response even if column doesn't exist
    }
  }

  return NextResponse.json({
    ...updated,
    filesImported: files.length,
  });
}
