import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/feedback
 * Store "Did this change help?" (Yes/No) for agent, composer, or debug apply.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { workspaceId?: string | null; source: "agent" | "composer" | "debug"; helpful: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const source = body.source;
  if (!["agent", "composer", "debug"].includes(source)) {
    return NextResponse.json({ error: "Invalid source" }, { status: 400 });
  }
  const workspaceId = typeof body.workspaceId === "string" && body.workspaceId.trim() ? body.workspaceId.trim() : null;
  await supabase.from("feedback").insert({
    user_id: user.id,
    workspace_id: workspaceId,
    source,
    helpful: !!body.helpful,
  });
  return NextResponse.json({ ok: true });
}
