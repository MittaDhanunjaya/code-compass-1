import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function simpleHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}
import type { FileEditStep } from "@/lib/agent/types";
import { getProtectedPaths } from "@/lib/protected-paths";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import {
  createSandboxFromWorkspace,
  applyEditsToSandbox,
  promoteSandboxToWorkspace,
  runSandboxChecks,
  syncSandboxToDisk,
  type SandboxRunMetadata,
} from "@/lib/sandbox";
import { recordModelOutcome } from "@/lib/llm/ab-stats";
import { runDebugFromLog } from "@/lib/debug-from-log-core";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    workspaceId?: string;
    steps?: FileEditStep[];
    confirmedProtectedPaths?: string[];
    source?: string;
    debugFromLogMeta?: { errorLog?: string; errorType?: string; modelUsed?: string; providerId?: string };
  };
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
  const isDebugFromLog = body.source === "debug-from-log";
  const debugMeta = body.debugFromLogMeta;

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
    // Create sandbox with ALL workspace files (needed for lint/test/run in sandbox)
    const sandboxMetadata: SandboxRunMetadata | undefined = isDebugFromLog && debugMeta
      ? {
          error_log: debugMeta.errorLog?.slice(0, 50000),
          error_type: debugMeta.errorType ?? undefined,
          model_used: debugMeta.modelUsed ?? undefined,
          proposed_edit_paths: steps.map((s) => s.path.trim()),
          first_error_at: new Date().toISOString(),
          error_fingerprint: debugMeta.errorLog
            ? simpleHash(debugMeta.errorLog.slice(0, 500).replace(/\s+/g, " "))
            : undefined,
        }
      : undefined;
    sandboxRunId = await createSandboxFromWorkspace(
      supabase,
      workspaceId,
      user.id,
      {
        source: isDebugFromLog ? "debug-from-log" : "composer",
        metadata: sandboxMetadata,
      }
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
      const { executeCommand } = await import("@/lib/agent/execute-command-server");
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
    
    // Only promote if checks passed (or skipped/not_configured). Block if any failed.
    const hasFailures = sandboxCheckResults.lint.status === "failed" || 
                       sandboxCheckResults.tests.status === "failed" || 
                       sandboxCheckResults.run.status === "failed";
    sandboxChecksPassed = !hasFailures;

    // A/B: record outcome for debug-from-log so we can prefer the model that wins more
    if (isDebugFromLog && debugMeta?.modelUsed) {
      const editSizeDelta = steps.reduce((acc, s) => acc + Math.abs((s.newContent?.length ?? 0) - (s.oldContent?.length ?? 0)), 0);
      recordModelOutcome(supabase, {
        userId: user.id,
        taskType: "patch",
        modelId: debugMeta.modelUsed,
        providerId: debugMeta.providerId ?? "openrouter",
        outcome: sandboxChecksPassed ? "win" : "loss",
        editSizeDelta,
        sandboxChecksPassed,
      }).catch(() => {});
    }

    if (sandboxChecksPassed) {
      const promoteResult = await promoteSandboxToWorkspace(supabase, sandboxRunId);
      filesEdited.push(...promoteResult.filesEdited);
      conflicts.push(...promoteResult.conflicts);
    } else {
      // Single automatic retry for debug-from-log: call runDebugFromLog with conservative + sandbox failure
      const attempt1Logs = [
        sandboxCheckResults.lint.status === "failed" ? `Lint: ${sandboxCheckResults.lint.logs}` : "",
        sandboxCheckResults.tests.status === "failed" ? `Tests: ${sandboxCheckResults.tests.logs}` : "",
        sandboxCheckResults.run.status === "failed" ? `Run: ${sandboxCheckResults.run.logs}` : "",
      ].filter(Boolean).join("\n");

      if (isDebugFromLog && debugMeta?.errorLog && attempt1Logs) {
        try {
          const failureSummary = `Sandbox checks failed after first fix attempt:\n${attempt1Logs}`;
          const retryResult = await runDebugFromLog(
            supabase,
            workspaceId,
            user.id,
            debugMeta.errorLog,
            { scopeMode: "conservative", sandboxFailureSummary: failureSummary }
          );
          const retrySteps: FileEditStep[] = (retryResult.edits ?? []).map((e) => ({
            type: "file_edit" as const,
            path: e.path,
            oldContent: e.oldContent,
            newContent: e.newContent,
            description: e.description,
            source: "debug-from-log" as const,
          }));
          if (retrySteps.length > 0) {
            const sandboxRunId2 = await createSandboxFromWorkspace(supabase, workspaceId, user.id, {
              source: "debug-from-log",
              metadata: sandboxMetadata,
            });
            const sandboxResult2 = await applyEditsToSandbox(supabase, sandboxRunId2, retrySteps);
            for (const step of retrySteps) {
              const path = step.path.trim();
              if (sandboxResult2.filesEdited.includes(path)) {
                log.push({ path, status: "ok", message: `Retry: applied edit to ${path}` });
              } else {
                const c = sandboxResult2.conflicts.find((x) => x.path === path);
                log.push({ path, status: "error", message: c?.message ?? "Retry edit failed" });
              }
            }
            const sandboxCheckResults2 = await runSandboxChecks(supabase, sandboxRunId2, executeSandboxCommand);
            const hasFailures2 = sandboxCheckResults2.lint.status === "failed" || sandboxCheckResults2.tests.status === "failed" || sandboxCheckResults2.run.status === "failed";
            if (!hasFailures2) {
              const promoteResult2 = await promoteSandboxToWorkspace(supabase, sandboxRunId2);
              filesEdited.length = 0;
              filesEdited.push(...promoteResult2.filesEdited);
              conflicts.length = 0;
              conflicts.push(...promoteResult2.conflicts);
              return NextResponse.json({
                success: true,
                filesEdited,
                log,
                conflicts,
                sandboxRunId: sandboxRunId2,
                sandboxChecks: sandboxCheckResults2,
                retried: true,
                retryReason: "sandbox_tests_failed",
                attempt1: { testsPassed: false, logs: attempt1Logs },
                attempt2: { testsPassed: true, logs: "" },
              });
            }
            return NextResponse.json({
              success: false,
              filesEdited: [],
              log,
              conflicts: [
                ...conflicts,
                { path: "", message: "Attempt 1: sandbox tests failed." },
                { path: "", message: "Attempt 2 (conservative retry): tests still failed. Please review the diffs and logs manually." },
              ],
              sandboxRunId: sandboxRunId2,
              sandboxChecks: sandboxCheckResults2,
              retried: true,
              retryReason: "sandbox_tests_failed",
              attempt1: { testsPassed: false, logs: attempt1Logs },
              attempt2: { testsPassed: false, logs: [sandboxCheckResults2.lint.logs, sandboxCheckResults2.tests.logs, sandboxCheckResults2.run.logs].filter(Boolean).join("\n") },
              message: "I tried twice and tests still fail. Please review the diffs and logs manually.",
            }, { status: 400 });
          }
        } catch (retryErr) {
          console.error("Debug-from-log retry failed:", retryErr);
        }
      }

      // Do not promote; add failure info to conflicts
      if (sandboxCheckResults.run.status === "failed") {
        conflicts.push({
          path: "",
          message: `Application failed to run. Changes were not applied. ${sandboxCheckResults.run.logs}`,
        });
      }
      if (sandboxCheckResults.lint.status === "failed") {
        conflicts.push({
          path: "",
          message: `Lint failed: ${sandboxCheckResults.lint.logs}`,
        });
      }
      if (sandboxCheckResults.tests.status === "failed") {
        conflicts.push({
          path: "",
          message: `Tests failed: ${sandboxCheckResults.tests.logs}`,
        });
      }
      return NextResponse.json({
        success: false,
        filesEdited: [],
        log,
        conflicts,
        sandboxRunId,
        sandboxChecks: sandboxCheckResults,
        message: "Sandbox checks failed. Fix errors before applying changes.",
      }, { status: 400 });
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
