import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { saveChatMessage } from "@/lib/chat-memory";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";

/**
 * POST /api/chat/save-message
 * Save a single message (e.g. debug run result) with runType for history filtering.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { workspaceId?: string; role: "user" | "assistant" | "system"; content: string; runType?: "chat" | "debug" | "agent" | "refactor" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json({ error: "Workspace required" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  const role = body.role ?? "assistant";
  const runType = body.runType ?? "chat";
  await saveChatMessage(supabase, workspaceId, user.id, role, content, { runType }).catch(() => {});
  return NextResponse.json({ ok: true });
}
