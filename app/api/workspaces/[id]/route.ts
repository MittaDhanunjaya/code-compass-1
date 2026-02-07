import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };

const WORKSPACE_SELECT_WITH_BRANCH =
  "id, name, created_at, updated_at, safe_edit_mode, github_repo_url, github_default_branch, github_owner, github_repo, github_is_private, github_current_branch";
const WORKSPACE_SELECT_WITHOUT_BRANCH =
  "id, name, created_at, updated_at, safe_edit_mode, github_repo_url, github_default_branch, github_owner, github_repo, github_is_private";

export async function GET(
  _request: Request,
  { params }: RouteParams
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let { data, error } = await supabase
    .from("workspaces")
    .select(WORKSPACE_SELECT_WITH_BRANCH)
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  // If error is about missing columns, try with fewer columns
  if (error && (error.message?.includes("github_current_branch") || error.message?.includes("safe_edit_mode") || error.message?.includes("column"))) {
    // If safe_edit_mode is missing, go straight to minimal columns
    if (error.message?.includes("safe_edit_mode")) {
      const retry2 = await supabase
        .from("workspaces")
        .select("id, name, created_at, updated_at")
        .eq("id", id)
        .eq("owner_id", user.id)
        .single();
      data = retry2.data;
      error = retry2.error;
      if (data) {
        // Add defaults for missing columns
        (data as any).safe_edit_mode = true;
        (data as any).github_repo_url = null;
        (data as any).github_default_branch = null;
        (data as any).github_owner = null;
        (data as any).github_repo = null;
        (data as any).github_is_private = null;
        (data as any).github_current_branch = null;
      }
    } else {
      // Try without github_current_branch first
      const retry1 = await supabase
        .from("workspaces")
        .select(WORKSPACE_SELECT_WITHOUT_BRANCH)
        .eq("id", id)
        .eq("owner_id", user.id)
        .single();
      
      if (retry1.error && retry1.error.message?.includes("column")) {
        // Try with minimal columns that definitely exist
        const retry2 = await supabase
          .from("workspaces")
          .select("id, name, created_at, updated_at")
          .eq("id", id)
          .eq("owner_id", user.id)
          .single();
        data = retry2.data;
        error = retry2.error;
        if (data) {
          // Add defaults for missing columns
          (data as any).safe_edit_mode = true;
          (data as any).github_repo_url = null;
          (data as any).github_default_branch = null;
          (data as any).github_owner = null;
          (data as any).github_repo = null;
          (data as any).github_is_private = null;
          (data as any).github_current_branch = null;
        }
      } else {
        data = retry1.data;
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
      .eq("owner_id", user.id)
      .single();
    if (minimalRetry.error || !minimalRetry.data) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    data = minimalRetry.data;
    // Add defaults
    (data as any).safe_edit_mode = true;
    (data as any).github_repo_url = null;
    (data as any).github_default_branch = null;
    (data as any).github_owner = null;
    (data as any).github_repo = null;
    (data as any).github_is_private = null;
    (data as any).github_current_branch = null;
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { name?: string; safe_edit_mode?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

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
    data = retry.data;
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
  _request: Request,
  { params }: RouteParams
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
