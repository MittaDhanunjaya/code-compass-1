/**
 * Phase 7.3: Redo last undone agent edit batch.
 * POST /api/workspaces/[id]/redo
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { popRedo, canUndo, canRedo } from "@/lib/edit-history";

type RouteParams = { params: Promise<{ id: string }> };

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

  const batch = popRedo(workspaceId);
  if (!batch) {
    return NextResponse.json({ error: "Nothing to redo", canRedo: false }, { status: 400 });
  }

  const reapplied: { path: string; content: string }[] = [];
  for (const { path, newContent } of batch) {
    const { data: existing } = await supabase
      .from("workspace_files")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .single();

    if (existing) {
      const { error } = await supabase
        .from("workspace_files")
        .update({ content: newContent, updated_at: new Date().toISOString() })
        .eq("workspace_id", workspaceId)
        .eq("path", path);
      if (!error) reapplied.push({ path, content: newContent });
    } else {
      const { error } = await supabase
        .from("workspace_files")
        .insert({
          workspace_id: workspaceId,
          path,
          content: newContent,
        });
      if (!error) reapplied.push({ path, content: newContent });
    }
  }

  return NextResponse.json({
    reapplied,
    canUndo: true,
    canRedo: canRedo(workspaceId),
  });
}
