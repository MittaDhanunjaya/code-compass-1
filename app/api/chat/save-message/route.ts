import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { saveChatMessage } from "@/lib/chat-memory";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { logger } from "@/lib/logger";

/**
 * POST /api/chat/save-message
 * Save a single message (e.g. debug run result) with runType for history filtering.
 */
export async function POST(request: Request) {
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
  try {
    await saveChatMessage(supabase, workspaceId, user.id, role, content, { runType });
  } catch (e) {
    logger.warn({ event: "save_chat_message_failed", workspaceId, userId: user.id, error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: "Failed to save message" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
