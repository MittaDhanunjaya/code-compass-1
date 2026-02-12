import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan } from "@/lib/agent/types";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { executeAgentPlan, PlanAgentError } from "@/services/agent.service";

export async function POST(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth();
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: {
    workspaceId?: string;
    plan?: AgentPlan;
    provider?: ProviderId;
    model?: string;
    confirmedProtectedPaths?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const plan = body.plan;
  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId || !plan?.steps?.length) {
    return NextResponse.json(
      { error: !workspaceId ? "No active workspace selected" : "plan with steps is required" },
      { status: 400 }
    );
  }

  try {
    const outcome = await executeAgentPlan({
      plan,
      workspaceId,
      userId: user.id,
      supabase,
      provider: body.provider,
      model: body.model,
      confirmedProtectedPaths: body.confirmedProtectedPaths,
    });

    if (!outcome.ok) {
      return NextResponse.json({
        needProtectedConfirmation: true,
        protectedPaths: outcome.protectedPaths,
      });
    }

    return NextResponse.json(outcome.result);
  } catch (e) {
    if (e instanceof PlanAgentError && e.code === "no_workspace") {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    const msg = e instanceof Error ? e.message : "Execution failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
