import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { pushEditBatch } from "@/lib/edit-history";

type RouteParams = { params: Promise<{ id: string }> };

/** Block edit if it replaces/deletes more than this fraction of the file (by line count). */
const LARGE_EDIT_RATIO = 0.4;
/** Full-file replace: warn when edit replaces nearly the entire file (e.g. "fix the error" mangled the file). */
const FULL_FILE_REPLACE_RATIO = 0.95;

/**
 * POST /api/workspaces/[id]/agent/apply-edits
 * Apply only the accepted file edits from Agent Phase F review.
 * Body: { edits: [{ path: string, content: string }], confirmLargeEdit?: boolean }
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
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

  let body: { edits?: { path: string; content: string }[]; confirmLargeEdit?: boolean; confirmFullFileReplace?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const edits = Array.isArray(body.edits) ? body.edits : [];
  const confirmLargeEdit = body.confirmLargeEdit === true;
  const confirmFullFileReplace = body.confirmFullFileReplace === true;
  if (edits.length === 0) {
    return NextResponse.json({ applied: [], error: "No edits provided" });
  }

  const applied: string[] = [];
  const largeEditPaths: string[] = [];
  const fullFileReplacePaths: string[] = [];
  const editHistoryBatch: { path: string; oldContent: string; newContent: string }[] = [];

  for (const { path, content } of edits) {
    const trimmedPath = (path ?? "").trim();
    if (!trimmedPath) continue;

    const { data: existing } = await supabase
      .from("workspace_files")
      .select("id, content")
      .eq("workspace_id", workspaceId)
      .eq("path", trimmedPath)
      .single();

    if (existing) {
      const originalContent = (existing.content as string) ?? "";
      const originalLines = originalContent.split("\n").length;
      const newLines = (content ?? "").split("\n").length;
      const maxLines = Math.max(originalLines, 1);
      const changeRatio = Math.abs(originalLines - newLines) / maxLines;
      if (changeRatio >= FULL_FILE_REPLACE_RATIO && !confirmFullFileReplace) {
        fullFileReplacePaths.push(trimmedPath);
        continue;
      }
      if (changeRatio > LARGE_EDIT_RATIO && !confirmLargeEdit) {
        largeEditPaths.push(trimmedPath);
        continue;
      }
      const { error } = await supabase
        .from("workspace_files")
        .update({ content: content ?? "", updated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("path", trimmedPath);
      if (!error) {
        applied.push(trimmedPath);
        editHistoryBatch.push({ path: trimmedPath, oldContent: originalContent, newContent: content ?? "" });
      }
    } else {
      const { error } = await supabase
        .from("workspace_files")
        .insert({
          workspace_id: workspaceId,
          path: trimmedPath,
          content: content ?? "",
        });
      if (!error) {
        applied.push(trimmedPath);
        editHistoryBatch.push({ path: trimmedPath, oldContent: "", newContent: content ?? "" });
      }
    }
  }

  if (editHistoryBatch.length > 0) {
    pushEditBatch(workspaceId, editHistoryBatch);
  }

  if (fullFileReplacePaths.length > 0) {
    return NextResponse.json(
      {
        applied,
        error: "Full file replace",
        details: "This replaces almost the entire file. If you didn't ask for a full rewrite, cancel and re-run with a clearer request. Add confirmFullFileReplace: true to apply anyway.",
        fullFileReplacePaths,
      },
      { status: 400 }
    );
  }

  if (largeEditPaths.length > 0) {
    return NextResponse.json(
      {
        applied,
        error: "Large edit blocked",
        details: `The following file(s) have a change of more than ${Math.round(LARGE_EDIT_RATIO * 100)}% of lines. Add confirmLargeEdit: true to apply anyway.`,
        largeEditPaths,
      },
      { status: 400 }
    );
  }

  return NextResponse.json({ applied });
}
