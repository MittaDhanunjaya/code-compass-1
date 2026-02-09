import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * PATCH /api/workspaces/[id]/files/sync
 * Bulk upsert files from a local folder re-sync.
 * Body: { files: [{ path: string, content: string }] }
 * For each item: update if path exists, else insert.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  let body: { files?: { path: string; content: string }[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  let synced = 0;
  for (const { path: rawPath, content } of files) {
    const path = (rawPath ?? "").trim();
    if (!path) continue;
    const safeContent = typeof content === "string" ? content.slice(0, 500_000) : "";

    const { data: existing } = await supabase
      .from("workspace_files")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .single();

    if (existing) {
      const { error } = await supabase
        .from("workspace_files")
        .update({ content: safeContent, updated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("path", path);
      if (!error) synced++;
    } else {
      const { error } = await supabase
        .from("workspace_files")
        .insert({
          workspace_id: workspaceId,
          path,
          content: safeContent,
        });
      if (!error) synced++;
    }
  }

  return NextResponse.json({ synced });
}
