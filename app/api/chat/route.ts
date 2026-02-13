import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { type ProviderId } from "@/lib/llm/providers";
import type { ChatMessage, ChatContext } from "@/lib/llm/types";
import { getTextFromContent } from "@/lib/llm/types";
import { detectErrorLogKind } from "@/lib/agent/error-log-utils";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { loadChatHistory } from "@/lib/chat-memory";
import { chatCompletion, ChatServiceError } from "@/services/chat.service";
import { getLLMUserFriendlyError, isAllModelsExhaustedError, errorResponse } from "@/lib/errors";

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
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  const runType = searchParams.get("runType") as "chat" | "debug" | "agent" | "refactor" | null;
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  const validRunTypes = ["chat", "debug", "agent", "refactor"];
  const filter = runType && validRunTypes.includes(runType) ? runType : undefined;
  const history = await loadChatHistory(supabase, workspaceId, user.id, 50, filter);
  return NextResponse.json({ messages: history });
}

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

  let body: {
    messages?: ChatMessage[];
    context?: ChatContext | null;
    model?: string;
    provider?: string;
    classifyOnly?: boolean;
    treatAsNormal?: boolean;
    runType?: "chat" | "debug" | "agent" | "refactor";
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const messages = body.messages ?? [];
  if (messages.length === 0) {
    return NextResponse.json(
      { error: "messages array is required" },
      { status: 400 }
    );
  }

  const lastMessage = messages[messages.length - 1];
  const workspaceId = await resolveWorkspaceId(
    supabase,
    user.id,
    body.context?.workspaceId
  );

  if (body.classifyOnly === true && lastMessage?.role === "user") {
    const text = getTextFromContent(lastMessage.content ?? "");
    const kind = detectErrorLogKind(text);
    return NextResponse.json({
      kind,
      requireConfirmation: kind === "error_log" && !!workspaceId,
      workspaceId: workspaceId ?? undefined,
      activeWorkspaceId: workspaceId ?? undefined,
    });
  }

  if (body.treatAsNormal !== true && lastMessage?.role === "user") {
    const kind = detectErrorLogKind(getTextFromContent(lastMessage.content ?? ""));
    if (kind === "error_log" && workspaceId) {
      return NextResponse.json({
        kind: "error_log",
        requireConfirmation: true,
        workspaceId,
        message: "These look like runtime logs. Confirm to debug against workspace or send as normal message.",
      });
    }
  }

  try {
    const result = await chatCompletion({
      messages,
      context: body.context,
      model: body.model,
      provider: body.provider as ProviderId | undefined,
      runType: body.runType,
      workspaceId,
      userId: user.id,
      supabase,
      origin: request.headers.get("origin") ?? undefined,
    });

    const { content, provider, usage, kind, contextUsed, noWorkspaceErrorLog } = result;
    return NextResponse.json({
      content,
      provider,
      usage,
      kind,
      contextUsed: contextUsed && (contextUsed.filePaths.length > 0 || contextUsed.rulesIncluded) ? contextUsed : undefined,
      ...(noWorkspaceErrorLog ? { noWorkspaceErrorLog: true } : {}),
    });
  } catch (e) {
    if (e instanceof ChatServiceError) {
      return NextResponse.json(
        { error: e.message },
        { status: 400 }
      );
    }
    if (isAllModelsExhaustedError(e)) {
      return errorResponse(e, { statusCode: 503 });
    }
    const err = e as Error & { statusCode?: number; status?: number; retryAfter?: number };
    const status = err.statusCode === 429 || err.status === 429 ? 429 : 502;
    const msg = getLLMUserFriendlyError(e, body.provider as string | undefined);
    console.error("[POST /api/chat]", e);
    const userMessage = msg.length > 300 ? `${msg.slice(0, 200)}…` : msg;
    const headers: Record<string, string> = {};
    if (status === 429 && err.retryAfter) headers["Retry-After"] = String(err.retryAfter);
    return NextResponse.json({ error: userMessage }, { status, headers });
  }
}
