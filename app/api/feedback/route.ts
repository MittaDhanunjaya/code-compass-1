import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { feedbackBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";

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
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const validation = validateBody(feedbackBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const body = validation.data;

  const source = body.source;
  const workspaceId = body.workspaceId && body.workspaceId.trim() ? body.workspaceId.trim() : null;
  await supabase.from("feedback").insert({
    user_id: user.id,
    workspace_id: workspaceId,
    source,
    helpful: body.helpful,
  });
  return NextResponse.json({ ok: true });
}
