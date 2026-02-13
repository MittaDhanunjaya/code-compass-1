import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { getOrSet, invalidateCache } from "@/lib/cache";

type RouteParams = { params: Promise<{ id: string }> };

const FILE_TREE_CACHE_TTL_MS = 60 * 1000; // 1 minute; invalidate on mutate

/**
 * GET /api/workspaces/[id]/files
 * List all files (paths only for tree building).
 *
 * GET /api/workspaces/[id]/files?path=src/app/page.tsx
 * Get single file content.
 */
export async function GET(
  request: Request,
  { params }: RouteParams
) {
  const { id: workspaceId } = await params;
  const { searchParams } = new URL(request.url);
  const pathParam = searchParams.get("path");

  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  if (pathParam) {
    // Get single file content
    const { data, error } = await supabase
      .from("workspace_files")
      .select("path, content, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("path", pathParam)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json(data);
  }

  // List all files (paths and updated_at for tree) - Phase 6.1.3: cache file tree
  const refreshParam = searchParams.get("refresh");
  const cacheKey = `filetree:${workspaceId}`;
  if (refreshParam === "1" || refreshParam === "true") {
    await invalidateCache(cacheKey);
  }
  try {
    const data = await getOrSet(
      cacheKey,
      FILE_TREE_CACHE_TTL_MS,
      async () => {
        const { data: list, error } = await supabase
          .from("workspace_files")
          .select("path, updated_at")
          .eq("workspace_id", workspaceId)
          .order("path", { ascending: true });

        if (error) throw new Error(error.message);
        return list ?? [];
      }
    );
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list files" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/workspaces/[id]/files
 * Create file or folder.
 * Body: { path: string, content?: string }
 * - For file: path = "src/app/page.tsx"
 * - For folder: path = "src/app/" (trailing slash)
 */
export async function POST(
  request: Request,
  { params }: RouteParams
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: { path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const path = (body.path ?? "").trim();
  if (!path) {
    return NextResponse.json(
      { error: "path is required" },
      { status: 400 }
    );
  }

  const content = body.content ?? "";

  const { data, error } = await supabase
    .from("workspace_files")
    .insert({
      workspace_id: workspaceId,
      path,
      content,
    })
    .select("id, path, content, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "File or folder already exists" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  await invalidateCache(`filetree:${workspaceId}`);
  return NextResponse.json(data);
}

/**
 * PATCH /api/workspaces/[id]/files
 * Rename: Body { oldPath, newPath }
 * Update content: Body { path, content }
 */
export async function PATCH(
  request: Request,
  { params }: RouteParams
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: { oldPath?: string; newPath?: string; path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // Update content: { path, content }
  if (body.path !== undefined && !body.oldPath) {
    const path = (body.path ?? "").trim();
    const content = body.content ?? "";
    if (!path) {
      return NextResponse.json(
        { error: "path is required" },
        { status: 400 }
      );
    }
    const { data, error } = await supabase
      .from("workspace_files")
      .update({ content, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .select("path, content, updated_at")
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "File not found" },
        { status: 404 }
      );
    }
    await invalidateCache(`filetree:${workspaceId}`);
    return NextResponse.json(data);
  }

  // Rename: { oldPath, newPath }
  const oldPath = (body.oldPath ?? "").trim();
  const newPath = (body.newPath ?? "").trim();
  if (!oldPath || !newPath) {
    return NextResponse.json(
      { error: "oldPath and newPath are required for rename" },
      { status: 400 }
    );
  }

  // Fetch all matching paths (folder = trailing slash, e.g. "src/")
  const folderPrefix = oldPath.replace(/\/$/, "");
  const isFolder = oldPath.endsWith("/");
  const { data: files } = await supabase
    .from("workspace_files")
    .select("id, path")
    .eq("workspace_id", workspaceId)
    .or(
      isFolder
        ? `path.eq.${folderPrefix},path.eq.${folderPrefix}/,path.like.${folderPrefix}/%`
        : `path.eq.${oldPath}`
    );

  if (!files || files.length === 0) {
    return NextResponse.json({ error: "File or folder not found" }, { status: 404 });
  }

  for (const file of files) {
    const newPrefix = newPath.replace(/\/$/, "");
    const targetPath = isFolder
      ? file.path.replace(
          new RegExp(`^${escapeRegex(folderPrefix)}/?`),
          newPrefix ? `${newPrefix}/` : newPrefix
        )
      : newPath;

    const { error } = await supabase
      .from("workspace_files")
      .update({ path: targetPath, updated_at: new Date().toISOString() })
      .eq("id", file.id);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: `Target already exists: ${targetPath}` },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }
  }

  await invalidateCache(`filetree:${workspaceId}`);
  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/workspaces/[id]/files?path=src/app/page.tsx
 * Delete file or folder. For folder, deletes all paths under it.
 */
export async function DELETE(
  request: Request,
  { params }: RouteParams
) {
  const { id: workspaceId } = await params;
  const { searchParams } = new URL(request.url);
  const pathParam = searchParams.get("path");

  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  if (!pathParam) {
    return NextResponse.json(
      { error: "path query parameter is required" },
      { status: 400 }
    );
  }

  const folderPrefix = pathParam.replace(/\/$/, "");
  const isFolder = pathParam.endsWith("/");

  // Check if it's a folder: explicit trailing slash, or has children
  const { data: folderCheck } = await supabase
    .from("workspace_files")
    .select("path")
    .eq("workspace_id", workspaceId)
    .or(`path.eq.${folderPrefix},path.eq.${folderPrefix}/,path.like.${folderPrefix}/%`);
  const hasChildren = folderCheck?.some(
    (f) => f.path.startsWith(folderPrefix + "/") || f.path === folderPrefix + "/"
  ) ?? false;
  const treatAsFolder = isFolder || hasChildren;

  if (treatAsFolder) {
    const { data: files } = await supabase
      .from("workspace_files")
      .select("id")
      .eq("workspace_id", workspaceId)
      .or(`path.eq.${folderPrefix},path.eq.${folderPrefix}/,path.like.${folderPrefix}/%`);

    if (!files || files.length === 0) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    const { error } = await supabase
      .from("workspace_files")
      .delete()
      .eq("workspace_id", workspaceId)
      .or(`path.eq.${folderPrefix},path.eq.${folderPrefix}/,path.like.${folderPrefix}/%`);

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }
  } else {
    const { data, error } = await supabase
      .from("workspace_files")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("path", pathParam)
      .select("id");

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  await invalidateCache(`filetree:${workspaceId}`);
  return NextResponse.json({ success: true });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
