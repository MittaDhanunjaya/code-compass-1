import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";

/**
 * PATCH /api/models/groups/[id]
 * Body: { label?: string, description?: string, modelIds?: string[] }
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  let body: { label?: string; description?: string; modelIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { data: group } = await supabase
    .from("model_groups")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!group) {
    return NextResponse.json({ error: "Group not found" }, { status: 404 });
  }

  const updates: { label?: string; description?: string; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (body.label !== undefined) updates.label = String(body.label).trim();
  if (body.description !== undefined) updates.description = String(body.description).trim() || undefined;

  if (Object.keys(updates).length > 1) {
    const { error } = await supabase
      .from("model_groups")
      .update(updates)
      .eq("id", id)
      .eq("user_id", user.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  if (Array.isArray(body.modelIds)) {
    await supabase.from("model_group_members").delete().eq("group_id", id);
    const roleOrder = ["planner", "coder", "reviewer"];
    const inserts = body.modelIds.slice(0, 10).map((modelId, i) => ({
      group_id: id,
      model_id: modelId,
      role: roleOrder[i] ?? "coder",
      priority: i,
    }));
    if (inserts.length > 0) {
      await supabase.from("model_group_members").insert(inserts);
    }
  }

  const { data: updated } = await supabase
    .from("model_groups")
    .select("id, label, description")
    .eq("id", id)
    .single();

  const { data: members } = await supabase
    .from("model_group_members")
    .select("model_id, role, priority")
    .eq("group_id", id)
    .order("priority", { ascending: true });

  return NextResponse.json({
    id: updated?.id,
    label: updated?.label,
    description: updated?.description ?? undefined,
    modelIds: (members ?? []).map((m) => m.model_id),
  });
}

/**
 * DELETE /api/models/groups/[id]
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("model_groups")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
