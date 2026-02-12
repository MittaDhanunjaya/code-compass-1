import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/models/user/[id]
 * Body: { enabled?: boolean, aliasLabel?: string }
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  let body: { enabled?: boolean; aliasLabel?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: { enabled?: boolean; alias_label?: string; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  if (body.aliasLabel !== undefined) updates.alias_label = String(body.aliasLabel).trim() || undefined;

  const { data, error } = await supabase
    .from("user_models")
    .update(updates)
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, model_id, enabled, alias_label")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: data.id,
    modelId: data.model_id,
    aliasLabel: data.alias_label ?? undefined,
    enabled: data.enabled,
  });
}

/**
 * DELETE /api/models/user/[id]
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("user_models")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
