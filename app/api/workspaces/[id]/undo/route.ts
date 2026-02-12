/**
 * Phase 7.3: Undo last agent edit batch.
 * POST /api/workspaces/[id]/undo
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { popUndo, canUndo, canRedo } from "@/lib/edit-history";

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

  const batch = popUndo(workspaceId);
  if (!batch) {
    return NextResponse.json({ error: "Nothing to undo", canUndo: false }, { status: 400 });
  }

  const reverted: { path: string; content: string }[] = [];
  for (const { path, oldContent } of batch) {
    const { error } = await supabase
      .from("workspace_files")
      .update({ content: oldContent, updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("path", path);
    if (!error) reverted.push({ path, content: oldContent });
  }

  return NextResponse.json({
    reverted,
    canUndo: canUndo(workspaceId),
    canRedo: true,
  });
}

export async function GET(request: Request, { params }: RouteParams) {
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

  return NextResponse.json({ canUndo: canUndo(workspaceId), canRedo: canRedo(workspaceId) });
}
