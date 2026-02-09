import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/models/groups
 * Returns user's groups with members (model id, label, role, priority).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: groups, error: gError } = await supabase
    .from("model_groups")
    .select("id, label, description")
    .eq("user_id", user.id);

  if (gError) {
    return NextResponse.json({ error: gError.message }, { status: 500 });
  }

  const result = await Promise.all(
    (groups ?? []).map(async (g) => {
      const { data: members } = await supabase
        .from("model_group_members")
        .select("id, model_id, role, priority")
        .eq("group_id", g.id)
        .order("priority", { ascending: true });

      const modelIds = (members ?? []).map((m) => m.model_id);
      const { data: modelRows } = await supabase
        .from("models")
        .select("id, label, provider, model_slug")
        .in("id", modelIds);

      const modelMap = new Map((modelRows ?? []).map((m) => [m.id, m]));
      const membersWithLabel = (members ?? []).map((m) => ({
        id: m.id,
        modelId: m.model_id,
        label: modelMap.get(m.model_id)?.label ?? m.model_id,
        role: m.role,
        priority: m.priority,
      }));

      return {
        id: g.id,
        label: g.label,
        description: g.description ?? undefined,
        members: membersWithLabel,
      };
    })
  );

  return NextResponse.json(result);
}

/**
 * POST /api/models/groups
 * Body: { label: string, description?: string, modelIds: string[] }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { label?: string; description?: string; modelIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const label = (body.label ?? "").trim();
  if (!label) {
    return NextResponse.json({ error: "label is required" }, { status: 400 });
  }

  const modelIds = Array.isArray(body.modelIds) ? body.modelIds : [];
  const description = body.description != null ? String(body.description).trim() || null : null;

  const { data: group, error: groupError } = await supabase
    .from("model_groups")
    .insert({
      user_id: user.id,
      label,
      description,
      updated_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (groupError || !group) {
    return NextResponse.json({ error: groupError?.message ?? "Failed to create group" }, { status: 500 });
  }

  const roleOrder = ["planner", "coder", "reviewer"];
  const inserts = modelIds.slice(0, 10).map((modelId, i) => ({
    group_id: group.id,
    model_id: modelId,
    role: roleOrder[i] ?? "coder",
    priority: i,
  }));

  if (inserts.length > 0) {
    const { error: memError } = await supabase.from("model_group_members").insert(inserts);
    if (memError) {
      await supabase.from("model_groups").delete().eq("id", group.id);
      return NextResponse.json({ error: memError.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    id: group.id,
    label,
    description: description ?? undefined,
    modelIds: inserts.map((i) => i.model_id),
  });
}
