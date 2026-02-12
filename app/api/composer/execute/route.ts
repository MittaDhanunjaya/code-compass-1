import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { executeComposer } from "@/services/composer.service";
import { composerExecuteBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";

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

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "composer-execute", 30);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again later.", retryAfter: rl.retryAfter },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } }
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const validation = validateBody(composerExecuteBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 }
    );
  }
  const body = validation.data;

  const steps = body.steps;
  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "No active workspace selected" },
      { status: 400 }
    );
  }

  const confirmedProtectedPaths = (body.confirmedProtectedPaths ?? []).map((p: string) => p.trim()).filter(Boolean);

  try {
    const outcome = await executeComposer({
      steps,
      workspaceId,
      userId: user.id,
      supabase,
      confirmedProtectedPaths,
      source: body.source === "debug-from-log" ? "debug-from-log" : undefined,
      debugFromLogMeta: body.debugFromLogMeta,
    });

    if ("needProtectedConfirmation" in outcome && outcome.needProtectedConfirmation) {
      return NextResponse.json({
        needProtectedConfirmation: true,
        protectedPaths: outcome.protectedPaths,
      });
    }

    const result = outcome as { success: boolean; filesEdited: string[]; log: unknown[]; conflicts: unknown[]; [k: string]: unknown };
    const status = result.success === false && (result.message || result.conflicts?.length) ? 400 : 200;
    return NextResponse.json({
      ...result,
      ...(result.sandboxRunId ? { sandboxRunId: result.sandboxRunId } : {}),
      ...(result.sandboxChecks ? { sandboxChecks: result.sandboxChecks } : {}),
    }, { status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Composer execute failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
