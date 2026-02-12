import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { workspacesUpdateBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";

type RouteParams = { params: Promise<{ id: string }> };

const WORKSPACE_SELECT_WITH_BRANCH =
  "id, name, created_at, updated_at, safe_edit_mode, github_repo_url, github_default_branch, github_owner, github_repo, github_is_private, github_current_branch";
const WORKSPACE_SELECT_WITHOUT_BRANCH =
  "id, name, created_at, updated_at, safe_edit_mode, github_repo_url, github_default_branch, github_owner, github_repo, github_is_private";

export async function GET(
  request: Request,
  { params }: RouteParams
) {
  const { id } = await params;
  const supabase = await createClient();
  let user: { id: string };
  try {
    const auth = await requireWorkspaceAccess(request, id, supabase);
    user = auth.user;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let { data, error } = await supabase
    .from("workspaces")
    .select(WORKSPACE_SELECT_WITH_BRANCH)
    .eq("id", id)
    .single();

  // If error is about missing columns, try with fewer columns
  if (error && (error.message?.includes("github_current_branch") || error.message?.includes("safe_edit_mode") || error.message?.includes("column"))) {
    // If safe_edit_mode is missing, go straight to minimal columns
    if (error.message?.includes("safe_edit_mode")) {
      const retry2 = await supabase
        .from("workspaces")
        .select("id, name, created_at, updated_at")
        .eq("id", id)
        .single();
      data = retry2.data as typeof data;
      error = retry2.error;
      if (data) {
        // Add defaults for missing columns
        Object.assign(data, {
          safe_edit_mode: true,
          github_repo_url: null,
          github_default_branch: null,
          github_owner: null,
          github_repo: null,
          github_is_private: null,
          github_current_branch: null,
        });
      }
    } else {
      // Try without github_current_branch first
      const retry1 = await supabase
        .from("workspaces")
        .select(WORKSPACE_SELECT_WITHOUT_BRANCH)
        .eq("id", id)
        .single();
      
      if (retry1.error && retry1.error.message?.includes("column")) {
        // Try with minimal columns that definitely exist
        const retry2 = await supabase
          .from("workspaces")
          .select("id, name, created_at, updated_at")
          .eq("id", id)
          .single();
        data = retry2.data as typeof data;
        error = retry2.error;
        if (data) {
          Object.assign(data, {
            safe_edit_mode: true,
            github_repo_url: null,
            github_default_branch: null,
            github_owner: null,
            github_repo: null,
            github_is_private: null,
            github_current_branch: null,
          });
        }
      } else {
        data = retry1.data as typeof data;
        error = retry1.error;
        if (data) {
          data.github_current_branch = null;
        }
      }
    }
  }

  if (error) {
    // Check if it's a "not found" error vs a column error
    const isNotFound = error.code === "PGRST116" || error.message?.includes("No rows");
    if (isNotFound) {
      console.error("Workspace not found:", "workspaceId:", id, "userId:", user.id);
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    // Column error - try with minimal columns
    console.warn("Workspace GET column error, retrying with minimal columns:", error.message);
    const minimalRetry = await supabase
      .from("workspaces")
      .select("id, name, created_at, updated_at")
      .eq("id", id)
      .single();
    if (minimalRetry.error || !minimalRetry.data) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    data = minimalRetry.data as typeof data;
    if (data) {
      Object.assign(data, {
        safe_edit_mode: true,
        github_repo_url: null,
        github_default_branch: null,
        github_owner: null,
        github_repo: null,
        github_is_private: null,
        github_current_branch: null,
      });
    }
  }

  if (!data) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}

export async function PATCH(
  request: Request,
  { params }: RouteParams
) {
  const { id } = await params;
  const supabase = await createClient();
  let user: { id: string };
  try {
    const auth = await requireWorkspaceAccess(request, id, supabase);
    user = auth.user;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { data: ws } = await supabase.from("workspaces").select("owner_id").eq("id", id).single();
  if (ws?.owner_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const validation = validateBody(workspacesUpdateBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const body = validation.data;

  const updates: { name?: string; safe_edit_mode?: boolean; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (body.name !== undefined) {
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }
    updates.name = name;
  }
  if (body.safe_edit_mode !== undefined) {
    updates.safe_edit_mode = !!body.safe_edit_mode;
  }

  let { data, error } = await supabase
    .from("workspaces")
    .update(updates)
    .eq("id", id)
    .eq("owner_id", user.id)
    .select(WORKSPACE_SELECT_WITH_BRANCH)
    .single();

  if (error && error.message?.includes("github_current_branch")) {
    // Column doesn't exist, retry without it
    const retry = await supabase
      .from("workspaces")
      .select(WORKSPACE_SELECT_WITHOUT_BRANCH)
      .eq("id", id)
      .eq("owner_id", user.id)
      .single();
    data = retry.data as typeof data;
    error = retry.error;
    if (data) {
      data.github_current_branch = null;
    }
  }

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}

export async function DELETE(
  request: Request,
  { params }: RouteParams
) {
  const { id } = await params;
  const supabase = await createClient();
  let user: { id: string };
  try {
    const auth = await requireWorkspaceAccess(request, id, supabase);
    user = auth.user;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const { data: ws } = await supabase.from("workspaces").select("owner_id").eq("id", id).single();
  if (ws?.owner_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error } = await supabase
    .from("workspaces")
    .delete()
    .eq("id", id)
    .eq("owner_id", user.id);

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
