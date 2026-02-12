/**
 * POST /api/agent/plan
 * Thin route: parse input → call agent service → return response.
 */

import { NextResponse } from "next/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { planAgent, PlanAgentError } from "@/services/agent.service";
import type { ProviderId } from "@/lib/llm/providers";
import { getUserFriendlyMessage } from "@/lib/errors";

export async function POST(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "agent-plan", 30);
  if (!rl.ok) {
    const retryAfter = rl.retryAfter ?? 60;
    return NextResponse.json(
      { error: getUserFriendlyMessage("rate_limit", { retryAfterSeconds: retryAfter }), retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  let body: {
    instruction?: string;
    workspaceId?: string;
    provider?: ProviderId;
    model?: string;
    fileList?: string[];
    fileContents?: Record<string, string>;
    useIndex?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const instruction = (body.instruction ?? "").trim();
  if (!instruction) {
    return NextResponse.json({ error: "instruction is required" }, { status: 400 });
  }

  try {
    const result = await planAgent(supabase, {
      userId: user.id,
      instruction,
      workspaceId: body.workspaceId,
      provider: body.provider,
      model: body.model,
      fileList: body.fileList,
      fileContents: body.fileContents,
      useIndex: body.useIndex,
    });

    return NextResponse.json({
      plan: result.plan,
      provider: result.provider,
      usage: result.usage,
    });
  } catch (e) {
    if (e instanceof PlanAgentError) {
      const status = e.code === "no_workspace" || e.code === "no_api_key" ? 400 : 500;
      return NextResponse.json({ error: e.message }, { status });
    }
    const msg = e instanceof Error ? e.message : "Plan generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
