import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import {
  getDefaultGroupIdOrNull,
  resolveDefaultGroup,
  resolveModelGroupId,
} from "@/lib/models/invocation-config";

/**
 * GET /api/models/default-group
 * Returns the effective default group for the user: either their saved group or the app-computed best default.
 * Response: { groupId: string | null, isUserSaved: boolean, label?: string, members: { modelId, label, role }[] }
 */
export async function GET(request: Request) {
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

  const savedGroupId = await getDefaultGroupIdOrNull(supabase, user.id);
  let members: { modelId: string; label: string; role: string }[];
  let label: string | undefined;
  let groupId: string | null;
  let isUserSaved: boolean;

  if (savedGroupId) {
    const configs = await resolveModelGroupId(supabase, user.id, savedGroupId);
    const { data: group } = await supabase
      .from("model_groups")
      .select("label")
      .eq("id", savedGroupId)
      .single();
    label = group?.label;
    groupId = savedGroupId;
    isUserSaved = true;
    members = configs.map((c) => ({
      modelId: c.modelId,
      label: c.modelLabel,
      role: c.role ?? "coder",
    }));
  } else {
    const configs = await resolveDefaultGroup(supabase, user.id);
    groupId = null;
    isUserSaved = false;
    label = undefined;
    members = configs.map((c) => ({
      modelId: c.modelId,
      label: c.modelLabel,
      role: c.role ?? "coder",
    }));
  }

  return NextResponse.json({
    groupId,
    isUserSaved,
    label,
    members,
  });
}

/**
 * PATCH /api/models/default-group
 * Body: { defaultModelGroupId: string | null }
 * Saves the user's default model group for Agent. Use null to clear and use app-computed default.
 */
export async function PATCH(request: Request) {
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

  let body: { defaultModelGroupId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const defaultModelGroupId = body.defaultModelGroupId === undefined ? undefined : body.defaultModelGroupId;

  if (defaultModelGroupId !== null && defaultModelGroupId !== undefined) {
    const { data: group } = await supabase
      .from("model_groups")
      .select("id")
      .eq("id", defaultModelGroupId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!group) {
      return NextResponse.json({ error: "Group not found or not yours" }, { status: 404 });
    }
  }

  const { error } = await supabase.from("user_agent_preferences").upsert(
    {
      user_id: user.id,
      default_model_group_id: defaultModelGroupId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
