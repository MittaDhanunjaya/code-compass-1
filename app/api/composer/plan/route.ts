import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { getUserFriendlyMessage } from "@/lib/errors";
import { type ProviderId } from "@/lib/llm/providers";
import type { ComposerScope } from "@/lib/composer/types";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { planComposer, ComposerPlanError } from "@/services/composer.service";
import { composerPlanBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";

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

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "composer-plan", 30);
  if (!rl.ok) {
    const retryAfter = rl.retryAfter ?? 60;
    return NextResponse.json(
      {
        error: getUserFriendlyMessage("rate_limit", { retryAfterSeconds: retryAfter }),
        retryAfter,
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
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

  const validation = validateBody(composerPlanBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 }
    );
  }
  const body = validation.data;

  const instruction = body.instruction;
  const scope = (body.scope ?? "current_file") as ComposerScope;
  const currentFilePath = body.currentFilePath?.trim() ?? null;
  const scopeMode = (body.scopeMode === "conservative" || body.scopeMode === "aggressive") ? body.scopeMode : "normal";

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "No active workspace selected" },
      { status: 400 }
    );
  }

  if (scope === "current_file" && !currentFilePath) {
    return NextResponse.json(
      { error: "currentFilePath is required for scope 'current_file'" },
      { status: 400 }
    );
  }
  if (scope === "current_folder" && !currentFilePath) {
    return NextResponse.json(
      { error: "currentFilePath is required for scope 'current_folder'" },
      { status: 400 }
    );
  }

  try {
    const result = await planComposer({
      instruction,
      scope,
      currentFilePath,
      scopeMode,
      workspaceId,
      userId: user.id,
      supabase,
      provider: body.provider as ProviderId | undefined,
      model: body.model,
      fileContents: body.fileContents,
    });

    return NextResponse.json({
      plan: result.plan,
      stepsWithContent: result.stepsWithContent,
      provider: result.provider,
      usage: result.usage,
    });
  } catch (e) {
    if (e instanceof ComposerPlanError) {
      if (e.code === "no_workspace") {
        return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      }
      if (e.code === "no_api_key") {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      if (e.code === "invalid_plan") {
        return NextResponse.json({ error: e.message }, { status: 502 });
      }
    }
    const err = e as Error & { statusCode?: number; retryAfter?: number };
    const status = err.statusCode === 429 ? 429 : 500;
    const msg = err instanceof Error ? err.message : "Composer plan failed";
    const headers: Record<string, string> = {};
    if (status === 429 && err.retryAfter) headers["Retry-After"] = String(err.retryAfter);
    return NextResponse.json({ error: msg }, { status, headers });
  }
}
