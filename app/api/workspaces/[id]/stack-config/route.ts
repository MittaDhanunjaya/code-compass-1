/**
 * GET /api/workspaces/[id]/stack-config
 * Returns effective stack config: from .code-compass/config.json (source: "file") or synthesized (source: "auto").
 *
 * POST /api/workspaces/[id]/stack-config
 * Writes .code-compass/config.json (only when current source is "auto").
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import {
  CODE_COMPASS_CONFIG_PATH,
  parseCodeCompassConfigFromContent,
  validateCodeCompassConfig,
  type CodeCompassConfig,
  type CodeCompassServiceConfig,
  type CodeCompassStack,
} from "@/lib/config/code-compass-config";
import { detectStackFromPaths } from "@/lib/sandbox/stack-commands";
import { getStackProfile } from "@/lib/sandbox/stack-profiles";
import type { StackKind } from "@/lib/sandbox/stack-commands";

type RouteParams = { params: Promise<{ id: string }> };

function stackKindToCodeCompassStack(kind: StackKind): CodeCompassStack {
  if (kind === "unknown") return "node";
  return kind as CodeCompassStack;
}

/** Build a default single-service config from detected stack and workspace paths. */
function buildDefaultConfig(paths: string[]): CodeCompassConfig {
  const stack = detectStackFromPaths(paths);
  const profile = getStackProfile(stack);
  const stackSlug = stackKindToCodeCompassStack(stack);
  const lintCommand = profile?.lintCommands?.[0];
  const testCommand = profile?.testCommands?.[0];
  const runCommand = profile?.runCommands?.[0]?.cmd;
  const svc: CodeCompassServiceConfig = {
    name: "default",
    root: ".",
    stack: stackSlug,
    lintCommand: lintCommand ?? undefined,
    testCommand: testCommand ?? undefined,
    runCommand: runCommand ?? undefined,
  };
  return { services: [svc] };
}

export async function GET(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const configPath = CODE_COMPASS_CONFIG_PATH;
  const { data: fileRow } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .eq("path", configPath)
    .single();

  if (fileRow?.content != null) {
    const content = typeof fileRow.content === "string" ? fileRow.content : "";
    const result = parseCodeCompassConfigFromContent(content);
    if (result.ok) {
      return NextResponse.json({ source: "file", config: result.value });
    }
    return NextResponse.json(
      { source: "file", errors: result.errors },
      { status: 400 }
    );
  }

  const { data: pathRows } = await supabase
    .from("workspace_files")
    .select("path")
    .eq("workspace_id", workspaceId)
    .limit(500);

  const paths = (pathRows ?? []).map((r) => r.path);
  const config = buildDefaultConfig(paths);
  return NextResponse.json({ source: "auto", config });
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const configPath = CODE_COMPASS_CONFIG_PATH;
  const { data: existingFile } = await supabase
    .from("workspace_files")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("path", configPath)
    .single();

  if (existingFile) {
    return NextResponse.json(
      {
        ok: false,
        error: "Config file already exists. Edit .code-compass/config.json in your repo.",
      },
      { status: 400 }
    );
  }

  let body: { config?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const config = body.config;
  const result = validateCodeCompassConfig(config);
  if (!result.ok) {
    return NextResponse.json({ ok: false, errors: result.errors }, { status: 400 });
  }

  const content = JSON.stringify(result.value, null, 2);

  const { error: insertError } = await supabase.from("workspace_files").insert({
    workspace_id: workspaceId,
    path: configPath,
    content,
  });

  if (insertError) {
    return NextResponse.json(
      { ok: false, error: insertError.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
