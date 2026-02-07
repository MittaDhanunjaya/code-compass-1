import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { FileEditStep } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { getProtectedPaths } from "@/lib/protected-paths";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import {
  createSandboxFromWorkspace,
  applyEditsToSandbox,
  promoteSandboxToWorkspace,
  runSandboxChecks,
  syncSandboxToDisk,
  getSandboxDir,
} from "@/lib/sandbox";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { workspaceId?: string; steps?: FileEditStep[]; confirmedProtectedPaths?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const steps = body.steps ?? [];
  const confirmedProtectedPaths = new Set((body.confirmedProtectedPaths ?? []).map((p) => p.trim()).filter(Boolean));

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "No active workspace selected" },
      { status: 400 }
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, safe_edit_mode")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const safeEditMode = workspace.safe_edit_mode !== false;
  const paths = steps.map((s) => s.path.trim());
  const protectedPaths = getProtectedPaths(paths);

  if (safeEditMode && protectedPaths.length > 0) {
    const allConfirmed = protectedPaths.every((p) => confirmedProtectedPaths.has(p));
    if (!allConfirmed) {
      return NextResponse.json({
        needProtectedConfirmation: true,
        protectedPaths,
      });
    }
  }

  const filesEdited: string[] = [];
  const conflicts: { path: string; message: string }[] = [];
  const log: { path: string; status: "ok" | "error"; message: string }[] = [];

  if (steps.length === 0) {
    return NextResponse.json({ filesEdited, log, conflicts });
  }

  // Process through sandbox
  let sandboxRunId: string | null = null;
  let sandboxChecksPassed = false;
  let sandboxCheckResults: { lint: { passed: boolean; logs: string }; tests: { passed: boolean; logs: string } } | null = null;

  try {
    // Create sandbox
    const editPaths = steps.map((s) => s.path.trim());
    sandboxRunId = await createSandboxFromWorkspace(
      supabase,
      workspaceId,
      user.id,
      { source: "composer", filePaths: editPaths }
    );

    // Apply edits to sandbox
    const sandboxResult = await applyEditsToSandbox(supabase, sandboxRunId, steps);

    // Log sandbox edit results
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const path = step.path.trim();
      if (sandboxResult.filesEdited.includes(path)) {
        log.push({ path, status: "ok", message: step.description ?? `Applied edit to ${path}` });
      } else {
        const conflict = sandboxResult.conflicts.find((c) => c.path === path);
        log.push({ path, status: "error", message: conflict?.message || "Edit failed" });
        if (conflict) conflicts.push(conflict);
      }
    }

    // Run sandbox checks
    const executeSandboxCommand = async (command: string, cwd: string) => {
      await syncSandboxToDisk(supabase, sandboxRunId!);
      const { executeCommand } = require("@/lib/agent/execute-command-server");
      const COMMAND_TIMEOUT_MS = 60000;
      try {
        const result = await executeCommand(command, cwd, COMMAND_TIMEOUT_MS);
        return {
          ok: result.exitCode === 0 && !result.errorMessage,
          exitCode: result.exitCode,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          durationMs: result.durationMs,
        };
      } catch (error) {
        return {
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : "Command execution failed",
          durationMs: 0,
        };
      }
    };

    sandboxCheckResults = await runSandboxChecks(supabase, sandboxRunId, executeSandboxCommand);
    
    // Allow promotion if checks passed OR if they were skipped/not configured
    // Only block if checks explicitly failed
    const hasFailures = sandboxCheckResults.lint.status === "failed" || 
                       sandboxCheckResults.tests.status === "failed" || 
                       sandboxCheckResults.run.status === "failed";
    sandboxChecksPassed = !hasFailures;

    // Always promote (even if checks failed, user can review)
    // But log failures
    const promoteResult = await promoteSandboxToWorkspace(supabase, sandboxRunId);
    filesEdited.push(...promoteResult.filesEdited);
    conflicts.push(...promoteResult.conflicts);
    
    // Add check failure info to conflicts if checks failed
    if (hasFailures) {
      if (sandboxCheckResults.run.status === "failed") {
        // CRITICAL: Run check failure - don't promote
        conflicts.push({
          path: "",
          message: `CRITICAL: Application failed to run. Changes will NOT be applied. ${sandboxCheckResults.run.logs}`,
        });
        // Don't promote if run check failed
        return NextResponse.json({
          success: false,
          conflicts,
          sandboxRunId,
          sandboxChecks: sandboxCheckResults,
          message: "Application failed to run. Please fix errors before applying changes.",
        });
      }
      if (sandboxCheckResults.lint.status === "failed") {
        conflicts.push({
          path: "",
          message: `Lint check failed: ${sandboxCheckResults.lint.logs}`,
        });
      }
      if (sandboxCheckResults.tests.status === "failed") {
        conflicts.push({
          path: "",
          message: `Test check failed: ${sandboxCheckResults.tests.logs}`,
        });
      }
    }
  } catch (sandboxError) {
    const errorMsg = sandboxError instanceof Error ? sandboxError.message : "Sandbox processing failed";
    log.push({ path: "", status: "error", message: `Sandbox error: ${errorMsg}` });
  }

  return NextResponse.json({
    filesEdited,
    log,
    conflicts,
    ...(sandboxRunId ? { sandboxRunId } : {}),
    ...(sandboxCheckResults ? { sandboxChecks: sandboxCheckResults } : {}),
  });
}
