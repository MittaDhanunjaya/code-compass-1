/**
 * CI endpoint: accept test/lint failure log and return suggested fixes.
 * Used by the GitHub Action template so teams can integrate Code Compass into CI.
 *
 * Auth: When CODE_COMPASS_CI_TOKEN is set, require Authorization: Bearer <token>.
 * Workspace: workspaceId via query (?workspaceId=) or X-Workspace-Id header.
 * Body: { logText: string }. Returns { suspectedRootCause, explanation, edits } (no apply).
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runDebugFromLog } from "@/lib/debug-from-log-core";

export async function POST(request: Request) {
  const workspaceId =
    request.headers.get("x-workspace-id") ??
    new URL(request.url).searchParams.get("workspaceId");
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;

  const ciToken = process.env.CODE_COMPASS_CI_TOKEN;
  if (ciToken && token !== ciToken) {
    return NextResponse.json({ error: "Invalid CI token" }, { status: 401 });
  }

  if (!workspaceId || typeof workspaceId !== "string" || !workspaceId.trim()) {
    return NextResponse.json(
      { error: "Missing or invalid workspaceId" },
      { status: 400 }
    );
  }

  let body: { logText?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const logText = typeof body.logText === "string" ? body.logText.trim() : "";
  if (!logText) {
    return NextResponse.json({ error: "logText is required" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: workspace, error: wsError } = await supabase
    .from("workspaces")
    .select("id, owner_id")
    .eq("id", workspaceId.trim())
    .single();

  if (wsError || !workspace) {
    return NextResponse.json(
      { error: "Missing or invalid workspaceId" },
      { status: 400 }
    );
  }

  const userId = (workspace as { owner_id: string }).owner_id;
  const result = await runDebugFromLog(
    supabase,
    workspaceId.trim(),
    userId,
    logText
  );

  return NextResponse.json({
    suspectedRootCause: result.suspectedRootCause,
    explanation: result.explanation,
    edits: result.edits.map((e) => ({
      path: e.path,
      description: e.description,
      newContent: e.newContent,
      oldContent: e.oldContent,
    })),
  });
}
