import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { getModelForProvider, type ProviderId } from "@/lib/llm/providers";
import type { AgentLogEntry, AgentExecuteResult, FileEditStep } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { executeCommandInWorkspace, executeCommand } from "@/lib/agent/execute-command-server";
import { classifyCommandKind, classifyCommandResult } from "@/lib/agent/command-classify";
import { proposeFixSteps, buildTails } from "@/lib/agent/self-debug";
import { buildSelfDebugContext } from "@/lib/agent/terminal-error-context";
import { getAllowedPaths, isPathAllowed, hashPlan } from "@/lib/agent/plan-lock";
import { isOfflineMode } from "@/lib/config";
import { validatePathForPlan } from "@/lib/agent/file-safety";
import { tryErrorRecovery } from "@/lib/agent/error-recovery";
import { validatePlanConsistency } from "@/lib/agent/plan-validator";
import { buildIntelligentContext } from "@/lib/indexing/intelligent-context";
import { getProtectedPaths } from "@/lib/protected-paths";
import { checkEditGuardrail, getGuardrailMode } from "@/lib/agent/guardrails";
import { createAgentEvent, formatStreamEvent, type AgentEvent } from "@/lib/agent-events";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import {
  createSandboxFromWorkspace,
  applyEditsToSandbox,
  runSandboxChecks,
  syncSandboxToDisk,
  type SandboxCheckResult,
  type SandboxSource,
} from "@/lib/sandbox";
import { beautifyCode } from "@/lib/utils/code-beautifier";
import { prepareEditContent } from "@/lib/formatters";
import { safeEnqueue, safeClose, shouldStopStream, STREAM_UPSTREAM_TIMEOUT_MS } from "@/lib/stream-utils";
import { enforceAndRecordBudget, BudgetExceededError, ServiceUnavailableError, STREAMING_RESERVE_TOKENS } from "@/lib/llm/budget-guard";
import { acquireStreamSlot, releaseStreamSlot } from "@/lib/stream-caps";
import { validateToolName, validateToolInput, acquireToolSlot, releaseToolSlot } from "@/services/tools/registry";
import { agentExecuteStreamBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";
import { logger, logAgentStarted, logAgentCompleted, getRequestId } from "@/lib/logger";
import { captureException } from "@/lib/sentry";
import { recordAgentExecuteDuration, recordLLMBudgetReserved, recordLLMBudgetExceeded } from "@/lib/metrics";

function commandKindToActionLabel(kind: "setup" | "test" | "other"): import("@/lib/agent/types").LogActionLabel {
  if (kind === "setup") return "CMD-SETUP";
  if (kind === "test") return "CMD-TEST";
  return "CMD-OTHER";
}

function isStreamClosed(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;
  return code === "ERR_INVALID_STATE" || msg.includes("already closed") || msg.includes("Invalid state");
}

function emitEvent(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  event: AgentEvent,
  closedRef?: { current: boolean }
) {
  if (closedRef?.current) return;
  try {
    controller.enqueue(encoder.encode(formatStreamEvent(event)));
  } catch (e) {
    if (closedRef && isStreamClosed(e)) {
      closedRef.current = true;
    }
    if (!closedRef?.current) {
      logger.error({ event: "execute_emit_failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
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

  if (process.env.NODE_ENV === "production" && !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "agent-execute-stream", 30);
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

  const validation = validateBody(agentExecuteStreamBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 }
    );
  }
  const body = validation.data;

  const plan = body.plan;
  const planHashFromClient = body.planHash;
  const confirmedProtectedPaths = new Set((body.confirmedProtectedPaths ?? []).map((p) => p.trim()).filter(Boolean));

  // Plan hash verification: refuse execution if plan was mutated after approval
  const computedHash = hashPlan(plan);
  if (computedHash !== planHashFromClient) {
    return NextResponse.json(
      {
        error: "Plan was modified after approval. Please re-run planning and approve again.",
        code: "PLAN_HASH_MISMATCH",
      },
      { status: 400 }
    );
  }
  const skipProtected = body.skipProtected === true;

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "No active workspace selected" },
      { status: 400 }
    );
  }

  if (isOfflineMode()) {
    return NextResponse.json(
      { error: "AI is offline. Remote model calls are disabled.", code: "OFFLINE_MODE" },
      { status: 503 }
    );
  }

  const streamCap = await acquireStreamSlot(user.id, workspaceId);
  if (!streamCap.ok) {
    return NextResponse.json(
      { error: streamCap.reason },
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    acquireToolSlot(user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Tool execution limit reached";
    return NextResponse.json({ error: msg }, { status: 429 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const execStart = Date.now();
      let execError: Error | null = null;
      const closed = { current: false };
      const safeEmit = (event: AgentEvent) => emitEvent(controller, encoder, event, closed);
      const requestId = getRequestId(request);

      try {
        await enforceAndRecordBudget(supabase, user.id, STREAMING_RESERVE_TOKENS, workspaceId, requestId);
        recordLLMBudgetReserved(STREAMING_RESERVE_TOKENS);
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          recordLLMBudgetExceeded();
          safeEmit(createAgentEvent("status", `Error: ${e.message}`));
          safeClose(controller);
          return;
        }
        if (e instanceof ServiceUnavailableError) {
          safeEmit(createAgentEvent("status", `Error: ${e.message}`));
          safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`);
          safeClose(controller);
          return;
        }
        throw e;
      }

      try {
        logAgentStarted({
          phase: "execute",
          workspaceId,
          userId: user.id,
          scopeMode: body.scopeMode,
          stepCount: plan.steps.length,
          requestId,
        });
        safeEmit(createAgentEvent('status', 'Agent execution started...'));

        // Try to get workspace with safe_edit_mode, fallback to minimal if column doesn't exist
        let { data: workspace, error: workspaceError } = await supabase
          .from("workspaces")
          .select("id, safe_edit_mode")
          .eq("id", workspaceId)
          .eq("owner_id", user.id)
          .single();

        // If error is about missing column, try with minimal columns
        if (workspaceError && (workspaceError.message?.includes("safe_edit_mode") || workspaceError.message?.includes("column"))) {
          const minimalRetry = await supabase
            .from("workspaces")
            .select("id")
            .eq("id", workspaceId)
            .eq("owner_id", user.id)
            .single();
          if (minimalRetry.error || !minimalRetry.data) {
            workspaceError = minimalRetry.error;
            workspace = null;
          } else {
            workspace = { ...minimalRetry.data, safe_edit_mode: true };
            workspaceError = null;
          }
        }

        if (workspaceError) {
          console.error("Workspace lookup error:", workspaceError);
          const errorMsg = workspaceError.code === "PGRST116" 
            ? "Workspace not found or you don't have access to it"
            : workspaceError.message || "Workspace lookup failed";
          safeEmit( createAgentEvent('status', `Error: ${errorMsg}`));
          const errorResult: AgentExecuteResult = {
            log: [],
            summary: `Error: ${errorMsg}`,
            filesEdited: [],
          };
          safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'result', result: errorResult })}\n\n`);
          safeClose(controller);
          return;
        }

        if (!workspace) {
          safeEmit( createAgentEvent('status', 'Error: Workspace not found'));
          const errorResult: AgentExecuteResult = {
            log: [],
            summary: "Error: Workspace not found or you don't have access to it",
            filesEdited: [],
          };
          safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'result', result: errorResult })}\n\n`);
          safeClose(controller);
          return;
        }

        // Default to safe mode if column doesn't exist
        const safeEditMode = (workspace as { safe_edit_mode?: boolean }).safe_edit_mode !== false;
        const scopeMode = body.scopeMode ?? "normal";
        const confirmedAggressive = body.confirmedAggressive === true;
        if (scopeMode === "aggressive" && safeEditMode && !confirmedAggressive) {
          safeEmit(createAgentEvent('status', 'Aggressive mode with Safe Edit on requires confirmation'));
          safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'needAggressiveConfirm' })}\n\n`);
          safeClose(controller);
          return;
        }

        const fileEditPaths = plan.steps.filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit").map((s) => s.path.trim());
        const protectedPaths = getProtectedPaths(fileEditPaths);

        const protectedSet = new Set(protectedPaths);
        if (safeEditMode && protectedPaths.length > 0) {
          const allConfirmed = protectedPaths.every((p) => confirmedProtectedPaths.has(p));
          if (!skipProtected && !allConfirmed) {
            safeEmit( createAgentEvent('status', 'Error: Protected files require confirmation'));
            safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'needProtectedConfirmation', protectedPaths })}\n\n`);
            safeClose(controller);
            return;
          }
        }

        const log: AgentLogEntry[] = [];
        if (skipProtected && protectedPaths.length > 0) {
          log.push({
            stepIndex: -1,
            type: "info",
            status: "ok",
            message: `Skipped protected files (user chose not to allow): ${protectedPaths.join(", ")}`,
            actionLabel: undefined,
            statusLine: `Skipped ${protectedPaths.length} protected file(s): ${protectedPaths.join(", ")}`,
          });
        }
        const filesEdited: string[] = [];

        // Plan lock: only allow file paths declared in plan
        const allowedPaths = getAllowedPaths(plan);

        // Plan consistency validation
        const fileContentsForValidation: Record<string, string> = {};
        const pathsToCheck = plan.steps.filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit").map((s) => s.path.trim());
        if (pathsToCheck.length > 0) {
          const { data: wf } = await supabase.from("workspace_files").select("path, content").eq("workspace_id", workspaceId).in("path", pathsToCheck);
          for (const row of wf ?? []) {
            fileContentsForValidation[row.path] = row.content ?? "";
          }
        }
        const planValidation = validatePlanConsistency(plan, Object.keys(fileContentsForValidation).length > 0 ? fileContentsForValidation : undefined);
        if (!planValidation.valid) {
          safeEmit(createAgentEvent("status", `Plan validation warnings: ${planValidation.errors.join("; ")}`));
          log.push({ stepIndex: -1, type: "info", status: "ok", message: planValidation.errors.join("; "), actionLabel: undefined, statusLine: "Plan validation warnings" });
        }

        safeEmit( createAgentEvent('reasoning', `Executing ${plan.steps.length} step(s)...`));

        // Separate file_edit steps from command steps for sandbox processing; filter by plan lock + file safety
        let fileEditSteps = plan.steps.filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit");
        const rejectedByLock: string[] = [];
        const rejectedBySafety: string[] = [];
        for (const step of fileEditSteps) {
          const path = step.path.trim();
          if (!allowedPaths.has(path)) rejectedByLock.push(path);
          else if (!validatePathForPlan(path).ok) rejectedBySafety.push(path);
        }
        if (rejectedByLock.length > 0) {
          const err = {
            type: "error",
            code: "internal_error",
            message: "Execution attempted to modify undeclared file.",
            details: rejectedByLock.join(", "),
          };
          safeEmit(createAgentEvent("status", `Error: ${err.message}`));
          safeEnqueue(controller, encoder, `data: ${JSON.stringify(err)}\n\n`);
          safeClose(controller);
          return;
        }
        fileEditSteps = fileEditSteps.filter((s) => {
          const p = s.path.trim();
          return allowedPaths.has(p) && validatePathForPlan(p).ok;
        });
        if (rejectedBySafety.length > 0) {
          safeEmit(createAgentEvent("status", `File safety: skipped ${rejectedBySafety.length} path(s)`));
        }

        // Guardrails: filter steps that exceed large-replace ratio or line-delta threshold
        const guardrailMode = getGuardrailMode();
        const skippedByGuardrail = new Set<string>();
        let stepsToApply = fileEditSteps;
        if (fileEditSteps.length > 0) {
          const paths = [...new Set(fileEditSteps.map((s) => s.path.trim()))];
          const { data: workspaceFiles } = await supabase
            .from("workspace_files")
            .select("path, content")
            .eq("workspace_id", workspaceId)
            .in("path", paths);
          const contentByPath = new Map<string, string>();
          for (const row of workspaceFiles ?? []) {
            contentByPath.set(row.path, row.content ?? "");
          }
          const filtered: typeof fileEditSteps = [];
          for (const step of fileEditSteps) {
            const path = step.path.trim();
            const originalContent = contentByPath.get(path) ?? "";
            const check = checkEditGuardrail(originalContent, step);
            if (check.overThreshold && check.reason) {
              safeEmit(createAgentEvent("guardrail_warning", `Large edit on ${path}: ${check.reason === "large_replacement_ratio" ? `${Math.round((check.ratio ?? 0) * 100)}% of file` : `line delta ${check.lineDelta}`}`, {
                guardrail: { path, reason: check.reason, ratio: check.ratio, lineDelta: check.lineDelta },
              }));
              if (guardrailMode === "strict") {
                skippedByGuardrail.add(path);
                continue;
              }
            }
            filtered.push(step);
          }
          stepsToApply = filtered;
        }

        let sandboxRunId: string | null = null;
        let sandboxChecksPassed = false;
        let sandboxCheckResults: SandboxCheckResult | null = null;
        let pendingReview: { fileEdits: { path: string; originalContent: string; newContent: string }[] } | null = null;

        // Process file edits through sandbox if any exist
        if (stepsToApply.length > 0) {
          try {
            safeEmit( createAgentEvent('status', 'Creating sandbox for this run...'));
            
            // Create sandbox with ALL workspace files (not just edited ones)
            // This ensures we have full project context (docker-compose.yml, package.json, etc.)
            // for proper run checks
            sandboxRunId = await createSandboxFromWorkspace(
              supabase,
              workspaceId,
              user.id,
              { source: "agent" as SandboxSource }
              // Don't pass filePaths - copy all files for complete project context
            );

            safeEmit( createAgentEvent('status', 'Applying edits in sandbox...'));

            // Apply edits to sandbox (only steps that passed guardrails)
            const sandboxResult = await applyEditsToSandbox(supabase, sandboxRunId, stepsToApply);

            // Log sandbox edit results (iterate all file_edit steps so UI shows every step)
            for (let i = 0; i < fileEditSteps.length; i++) {
              const step = fileEditSteps[i];
              const path = step.path.trim();

              // 3.2.2: Validate tool input against registry schema
              try {
                validateToolInput<{ path: string; oldContent?: string; newContent: string }>("edit_file", {
                  path: step.path,
                  oldContent: step.oldContent,
                  newContent: step.newContent,
                });
              } catch (validationErr) {
                const msg = validationErr instanceof Error ? validationErr.message : "Invalid edit_file input";
                safeEmit(createAgentEvent("tool_result", `Skipped (invalid): ${path} — ${msg}`, { toolName: "edit_file", filePath: path, stepIndex: i }));
                log.push({ stepIndex: i, type: "file_edit", status: "error", message: msg, path, actionLabel: "EDIT", statusLine: `Skipped: ${path}` });
                continue;
              }

              if (skippedByGuardrail.has(path)) {
                safeEmit(createAgentEvent("tool_result", `Skipped (large edit guardrail): ${path}`, {
                  toolName: "edit_file",
                  filePath: path,
                  stepIndex: i,
                }));
                log.push({
                  stepIndex: i,
                  type: "file_edit",
                  status: "skipped",
                  message: `Skipped (large edit guardrail): ${path}`,
                  path,
                  actionLabel: "EDIT",
                  statusLine: `Skipped (large edit guardrail): ${path}`,
                });
                continue;
              }
              
              if (skipProtected && protectedSet.has(path)) {
                safeEmit( createAgentEvent('tool_result', `Skipped protected file: ${path}`, {
                  toolName: 'edit_file',
                  filePath: path,
                  stepIndex: i,
                }));
                log.push({
                  stepIndex: i,
                  type: "file_edit",
                  status: "ok",
                  message: `Skipped (protected): ${path}`,
                  path,
                  actionLabel: "EDIT",
                  statusLine: `Skipped protected file: ${path}`,
                });
                continue;
              }

              safeEmit( createAgentEvent('tool_call', `Editing file ${path}`, {
                toolName: 'edit_file',
                filePath: path,
                stepIndex: i,
              }));

              if (sandboxResult.filesEdited.includes(path)) {
                safeEmit( createAgentEvent('tool_result', `Applied edit to ${path}`, {
                  toolName: 'edit_file',
                  filePath: path,
                  stepIndex: i,
                }));
                log.push({
                  stepIndex: i,
                  type: "file_edit",
                  status: "ok",
                  message: step.description ?? `Applied edit to ${path}`,
                  path,
                  actionLabel: "EDIT",
                  statusLine: `Applied edit to ${path}`,
                });
              } else {
                const conflict = sandboxResult.conflicts.find((c) => c.path === path);
                const conflictMessage = conflict?.message || "Edit failed";
                safeEmit( createAgentEvent('tool_result', `Edit failed: ${path} — ${conflictMessage}`, {
                  toolName: 'edit_file',
                  filePath: path,
                  stepIndex: i,
                  conflict: true,
                }));
                log.push({
                  stepIndex: i,
                  type: "file_edit",
                  status: "error",
                  message: conflictMessage,
                  path,
                  actionLabel: "EDIT",
                  statusLine: `Edit failed: ${path} — ${conflictMessage}`,
                });
              }
            }

            // Run sandbox checks (lint/tests)
            validateToolName("run_command");
            safeEmit( createAgentEvent('status', 'Running lint in sandbox...'));
            safeEmit( createAgentEvent('tool_call', 'Running lint check', {
              toolName: 'run_command',
              command: 'npm run lint',
            }));

            // Create command executor for sandbox
            const executeSandboxCommand = async (command: string, cwd: string) => {
              await syncSandboxToDisk(supabase, sandboxRunId!);
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

            const lintStatus = sandboxCheckResults.lint.status;
            const lintStatusText = lintStatus === "passed" ? "passed" : lintStatus === "failed" ? "failed" : lintStatus === "skipped" ? "skipped" : "not configured";
            safeEmit( createAgentEvent('tool_result', `Lint ${lintStatusText}${sandboxCheckResults.lint.logs ? `: ${sandboxCheckResults.lint.logs.slice(0, 100)}` : ''}`, {
              toolName: 'run_command',
              command: 'lint',
            }));

            safeEmit( createAgentEvent('status', 'Running tests in sandbox...'));
            safeEmit( createAgentEvent('tool_call', 'Running test check', {
              toolName: 'run_command',
              command: 'npm test',
            }));

            const testStatus = sandboxCheckResults.tests.status;
            const testStatusText = testStatus === "passed" ? "passed" : testStatus === "failed" ? "failed" : testStatus === "skipped" ? "skipped" : "not configured";
            safeEmit( createAgentEvent('tool_result', `Tests ${testStatusText}${sandboxCheckResults.tests.logs ? `: ${sandboxCheckResults.tests.logs.slice(0, 100)}` : ''}`, {
              toolName: 'run_command',
              command: 'test',
            }));

            // Run application check
            safeEmit( createAgentEvent('status', 'Verifying application runs in sandbox...'));
            safeEmit( createAgentEvent('tool_call', 'Running application check', {
              toolName: 'run_command',
              command: 'start',
            }));

            const runStatus = sandboxCheckResults.run.status;
            const runStatusText = runStatus === "passed" ? "passed" : runStatus === "failed" ? "failed" : runStatus === "skipped" ? "skipped" : "not configured";
            safeEmit( createAgentEvent('tool_result', `Application ${runStatusText}${sandboxCheckResults.run.logs ? `: ${sandboxCheckResults.run.logs.slice(0, 150)}` : ''}`, {
              toolName: 'run_command',
              command: 'start',
            }));

            // CRITICAL: Block promotion if run check fails - application must actually run
            // Allow promotion if checks passed OR if they were skipped/not configured
            // Only block if checks explicitly failed
            const hasFailures = lintStatus === "failed" || testStatus === "failed" || runStatus === "failed";
            sandboxChecksPassed = !hasFailures;

            // If run check failed, this is critical - don't promote
            if (runStatus === "failed") {
              safeEmit( createAgentEvent('status', 'CRITICAL: Application failed to run. Changes will NOT be applied. Please fix errors and try again.'));
            }

            if (sandboxChecksPassed) {
              const allPassed = lintStatus === "passed" && testStatus === "passed" && runStatus === "passed";
              if (allPassed) {
                safeEmit( createAgentEvent('status', 'All sandbox checks passed. Review changes below and apply accepted edits.'));
              } else if (runStatus === "passed") {
                safeEmit( createAgentEvent('status', 'Application runs successfully. Review changes below and apply accepted edits.'));
              } else {
                safeEmit( createAgentEvent('status', 'Sandbox checks skipped/not configured. Review changes below and apply accepted edits.'));
              }
              
              // Phase F: do not promote; build pending_review for client to accept/reject per file
              const editedPaths = sandboxResult.filesEdited;
              if (editedPaths.length > 0) {
                const { data: sandboxFileRows } = await supabase
                  .from("sandbox_files")
                  .select("path, content")
                  .eq("sandbox_run_id", sandboxRunId)
                  .in("path", editedPaths);
                const { data: workspaceFileRows } = await supabase
                  .from("workspace_files")
                  .select("path, content")
                  .eq("workspace_id", workspaceId)
                  .in("path", editedPaths);
                const newByPath = new Map<string, string>();
                const originalByPath = new Map<string, string>();
                for (const row of sandboxFileRows ?? []) {
                  newByPath.set(row.path, row.content ?? "");
                }
                for (const row of workspaceFileRows ?? []) {
                  originalByPath.set(row.path, row.content ?? "");
                }
                pendingReview = {
                  fileEdits: editedPaths.map((path) => ({
                    path,
                    originalContent: originalByPath.get(path) ?? "",
                    newContent: newByPath.get(path) ?? "",
                  })),
                };
              }
            } else {
              // Checks failed
              if (runStatus === "failed") {
                // CRITICAL: Run check failure means app doesn't work - DON'T promote
                safeEmit( createAgentEvent('status', 'CRITICAL: Application failed to run. Changes will NOT be applied. Please review errors and fix before trying again.'));
                
                // Log run check failure
                log.push({
                  stepIndex: -1,
                  type: "info",
                  status: "error",
                  message: `Application failed to run: ${sandboxCheckResults.run.logs}`,
                  actionLabel: undefined,
                  statusLine: `Application run check failed - the app does not work correctly`,
                });
                
                // Also log lint/test failures if present
                if (lintStatus === "failed") {
                  log.push({
                    stepIndex: -1,
                    type: "info",
                    status: "error",
                    message: `Lint failed: ${sandboxCheckResults.lint.logs}`,
                    actionLabel: undefined,
                    statusLine: `Lint check failed`,
                  });
                }
                if (testStatus === "failed") {
                  log.push({
                    stepIndex: -1,
                    type: "info",
                    status: "error",
                    message: `Tests failed: ${sandboxCheckResults.tests.logs}`,
                    actionLabel: undefined,
                    statusLine: `Test check failed`,
                  });
                }
                
                // DO NOT promote - app doesn't work
              } else {
                // Lint/test failures - still offer review (app runs, just has code quality issues)
                safeEmit( createAgentEvent('status', 'Sandbox checks failed (lint/tests). Application runs. Review changes below and apply if desired.'));
                
                // Phase F: build pending_review instead of promoting
                const editedPathsElse = sandboxResult.filesEdited;
                if (editedPathsElse.length > 0) {
                  const { data: sandboxFileRows } = await supabase
                    .from("sandbox_files")
                    .select("path, content")
                    .eq("sandbox_run_id", sandboxRunId)
                    .in("path", editedPathsElse);
                  const { data: workspaceFileRows } = await supabase
                    .from("workspace_files")
                    .select("path, content")
                    .eq("workspace_id", workspaceId)
                    .in("path", editedPathsElse);
                  const newByPath = new Map<string, string>();
                  const originalByPath = new Map<string, string>();
                  for (const row of sandboxFileRows ?? []) {
                    newByPath.set(row.path, row.content ?? "");
                  }
                  for (const row of workspaceFileRows ?? []) {
                    originalByPath.set(row.path, row.content ?? "");
                  }
                  pendingReview = {
                    fileEdits: editedPathsElse.map((path) => ({
                      path,
                      originalContent: originalByPath.get(path) ?? "",
                      newContent: newByPath.get(path) ?? "",
                    })),
                  };
                }
                
                // Log check failures
                if (lintStatus === "failed") {
                  log.push({
                    stepIndex: -1,
                    type: "info",
                    status: "error",
                    message: `Lint failed: ${sandboxCheckResults.lint.logs}`,
                    actionLabel: undefined,
                    statusLine: `Lint check failed`,
                  });
                }
                if (testStatus === "failed") {
                  log.push({
                    stepIndex: -1,
                    type: "info",
                    status: "error",
                    message: `Tests failed: ${sandboxCheckResults.tests.logs}`,
                    actionLabel: undefined,
                    statusLine: `Test check failed`,
                  });
                }
              }
            }
          } catch (sandboxError) {
            const errorMsg = sandboxError instanceof Error ? sandboxError.message : "Sandbox processing failed";
            safeEmit( createAgentEvent('status', `Sandbox error: ${errorMsg}`));
            log.push({
              stepIndex: -1,
              type: "info",
              status: "error",
              message: `Sandbox processing failed: ${errorMsg}`,
              actionLabel: undefined,
              statusLine: `Sandbox error: ${errorMsg}`,
            });
          }
        }

        /** Get API key for self-debug LLM (lazy). */
        let selfDebugApiKey: string | null = null;
        let selfDebugProviderId: ProviderId | null = null;
        let resolvedModelSlug: string | undefined;
        const { resolveInvocationConfig, getConfigByRole } = await import("@/lib/models/invocation-config");
        const defaultConfigs = await resolveInvocationConfig(supabase, user.id, {
          modelId: body.modelId,
          modelGroupId: body.modelGroupId,
        });
        const coderConfig = defaultConfigs.length > 0 ? (getConfigByRole(defaultConfigs, "coder") ?? defaultConfigs[0]) : null;
        if (coderConfig) {
          selfDebugApiKey = coderConfig.apiKey || "";
          selfDebugProviderId = coderConfig.providerId;
          resolvedModelSlug = coderConfig.modelSlug;
        }
        const getSelfDebugApiKey = async (): Promise<{ apiKey: string; providerId: ProviderId } | null> => {
          if (selfDebugApiKey !== null && selfDebugProviderId) return { apiKey: selfDebugApiKey, providerId: selfDebugProviderId };
          return null;
        };

        // Process command steps (file_edit steps were already processed through sandbox)
        const execStartTime = Date.now();
        for (let i = 0; i < plan.steps.length; i++) {
          if (shouldStopStream(request, execStartTime, STREAM_UPSTREAM_TIMEOUT_MS)) break;
          const step = plan.steps[i];

          // Skip file_edit steps - they were already processed through sandbox above
          if (step.type === "file_edit") {
            continue;
          }

          if (step.type === "command") {
            // 3.2.2: Validate tool input against registry schema
            try {
              validateToolInput<{ command: string; cwd?: string }>("run_command", { command: step.command });
            } catch (validationErr) {
              const msg = validationErr instanceof Error ? validationErr.message : "Invalid run_command input";
              safeEmit(createAgentEvent("tool_result", `Skipped: ${step.command} — ${msg}`, { toolName: "run_command", command: step.command, stepIndex: i }));
              log.push({ stepIndex: i, type: "command", status: "error", message: msg, command: step.command, actionLabel: "CMD-OTHER", statusLine: `Skipped: ${msg}` });
              continue;
            }
            const commandKind = classifyCommandKind(step.command);
            safeEmit( createAgentEvent('tool_call', `Running command: ${step.command}`, {
              toolName: 'run_command',
              command: step.command,
              stepIndex: i,
            }));

            try {
              const cmdResult = await executeCommandInWorkspace(supabase, workspaceId, step.command);
              const classification = classifyCommandResult(cmdResult);

              const status: "ok" | "skipped" | "error" = classification.status === "success" ? "ok" : "error";
              let message = "";
              if (cmdResult.errorMessage) message = cmdResult.errorMessage;
              else if (cmdResult.exitCode === null) message = "Command timed out";
              else if (cmdResult.exitCode === 0) message = cmdResult.stdout || "Command completed successfully";
              else message = cmdResult.stderr || `Command failed with exit code ${cmdResult.exitCode}`;
              const outputParts: string[] = [];
              if (cmdResult.stdout) outputParts.push(`stdout: ${cmdResult.stdout}`);
              if (cmdResult.stderr) outputParts.push(`stderr: ${cmdResult.stderr}`);
              if (outputParts.length > 0) message += `\n${outputParts.join("\n")}`;

              const cmdLabel = commandKindToActionLabel(commandKind);
              const firstRunLine = `${step.command} — ${classification.status}${classification.summary ? ` (${classification.summary})` : ""}`;
              const commandEntry: AgentLogEntry = {
                stepIndex: i,
                type: "command",
                status,
                message: message.trim(),
                command: step.command,
                commandKind,
                commandStatus: classification.status,
                commandStatusSummary: classification.summary,
                actionLabel: cmdLabel,
                statusLine: firstRunLine,
              };
              log.push(commandEntry);

              safeEmit( createAgentEvent('tool_result', `${step.command} — ${classification.status}${classification.summary ? ` (${classification.summary})` : ""}`, {
                toolName: 'run_command',
                command: step.command,
                stepIndex: i,
              }));

              // Deterministic error recovery: rule-based fixes before LLM escalation
              let recoveryAttempted = false;
              if (classification.status === "failed") {
                const recovery = await tryErrorRecovery(step.command, cmdResult.stderr ?? "", cmdResult.stdout ?? "");
                if (recovery.fixed && recovery.retry) {
                  recoveryAttempted = true;
                  safeEmit(createAgentEvent("reasoning", `Auto-recovery: ${recovery.reason}`));
                  const retryResult = await executeCommandInWorkspace(supabase, workspaceId, recovery.command);
                  const retryClassification = classifyCommandResult(retryResult);
                  if (retryClassification.status === "success") {
                    commandEntry.autoFixAttempted = true;
                    commandEntry.secondRunStatus = retryClassification.status;
                    commandEntry.secondRunSummary = retryClassification.summary;
                    commandEntry.statusLine = `${firstRunLine}; Auto-recovery: ${recovery.reason}, passed`;
                    safeEmit(createAgentEvent("tool_result", `Auto-recovery succeeded: ${recovery.reason}`, { toolName: "run_command", command: step.command, stepIndex: i }));
                    continue;
                  }
                  safeEmit(createAgentEvent("tool_result", `Auto-recovery failed: ${retryClassification.summary}`, { toolName: "run_command", command: step.command, stepIndex: i }));
                }
              }

              // Enhanced self-debug: multiple retry attempts for failed commands
              // Trigger for: test/setup failures, port conflicts, and other runtime errors
              const MAX_DEBUG_ATTEMPTS = 5;
              const isPortConflict = (cmdResult.stderr?.toLowerCase().includes("port") && cmdResult.stderr?.toLowerCase().includes("already in use")) ||
                                     (cmdResult.stdout?.toLowerCase().includes("port") && cmdResult.stdout?.toLowerCase().includes("already in use")) ||
                                     cmdResult.stderr?.toLowerCase().includes("eaddrinuse");
              
              if (
                classification.status === "failed" &&
                !recoveryAttempted &&
                ((commandKind === "test" || commandKind === "setup") || isPortConflict)
              ) {
                const creds = await getSelfDebugApiKey();
                if (creds) {
                  const applyFileEdit = async (path: string, newContent: string, oldContent?: string): Promise<boolean> => {
                    const normalized = path.trim();
                    if (!allowedPaths.has(normalized)) {
                      const err = { type: "error", code: "internal_error", message: "Execution attempted to modify undeclared file.", details: normalized };
                      safeEmit(createAgentEvent("status", `Error: ${err.message}`));
                      safeEnqueue(controller, encoder, `data: ${JSON.stringify(err)}\n\n`);
                      safeClose(controller);
                      throw new Error(err.message);
                    }
                    const { data: fileRow } = await supabase
                      .from("workspace_files")
                      .select("content")
                      .eq("workspace_id", workspaceId)
                      .eq("path", path)
                      .single();
                    if (!fileRow) {
                      const prepared = await prepareEditContent(newContent, path);
                      const { error } = await supabase
                        .from("workspace_files")
                        .insert({ workspace_id: workspaceId, path, content: prepared });
                      if (!error && !filesEdited.includes(path)) filesEdited.push(path);
                      return !error;
                    }
                    const currentContent = fileRow.content ?? "";
                    const preparedContent = await prepareEditContent(newContent, path);
                    const result = applyEdit(currentContent, preparedContent, oldContent);
                    if (!result.ok) return false;
                    const { error } = await supabase
                      .from("workspace_files")
                      .update({ content: result.content, updated_at: new Date().toISOString() })
                      .eq("workspace_id", workspaceId)
                      .eq("path", path);
                    if (!error && !filesEdited.includes(path)) filesEdited.push(path);
                    return !error;
                  };
                  const previousAttempts: Array<{
                    attempt: number;
                    steps: FileEditStep[];
                    result: { status: string; summary: string };
                  }> = [];
                  
                  let lastResult = cmdResult;
                  let lastClassification = classification;
                  let totalFixSteps = 0;
                  
                  // Build intelligent context automatically (discovers relevant files based on codebase structure)
                  let workspaceFileList: string[] = [];
                  const relevantFileContents: Record<string, string> = {};
                  
                  if (classification.status === "failed" && workspaceId) {
                    try {
                      // Use intelligent context builder to discover relevant files
                      const intelligentContext = await buildIntelligentContext(
                        supabase,
                        workspaceId,
                        null,
                        `${step.command}\n${lastResult.stdout}\n${lastResult.stderr}`
                      );
                      
                      workspaceFileList = intelligentContext.relatedFiles.map(f => f.path);
                      
                      // Add current file if available
                      if (intelligentContext.currentFile) {
                        workspaceFileList.unshift(intelligentContext.currentFile.path);
                        relevantFileContents[intelligentContext.currentFile.path] = intelligentContext.currentFile.content;
                      }
                      
                      // Add related files
                      for (const file of intelligentContext.relatedFiles.slice(0, 5)) {
                        relevantFileContents[file.path] = file.content;
                      }
                      
                      // Add config files
                      for (const configPath of intelligentContext.codebaseStructure.configFiles.slice(0, 3)) {
                        const { data: configFile } = await supabase
                          .from("workspace_files")
                          .select("content")
                          .eq("workspace_id", workspaceId)
                          .eq("path", configPath)
                          .single();
                        if (configFile?.content) {
                          relevantFileContents[configPath] = configFile.content;
                        }
                      }
                    } catch (e) {
                      console.error("Error building intelligent context for self-debug:", e);
                    }
                  }
                  
                  for (let attempt = 1; attempt <= MAX_DEBUG_ATTEMPTS; attempt++) {
                    safeEmit( createAgentEvent('reasoning', `Auto-fix attempt ${attempt}/${MAX_DEBUG_ATTEMPTS}...`));
                    
                    const tails = buildTails(lastResult.stdout ?? "", lastResult.stderr ?? "");
                    const debugCtx = buildSelfDebugContext(step.command, lastResult, tails);
                    const fixSteps = await proposeFixSteps(
                      {
                        command: debugCtx.command,
                        stdoutTail: debugCtx.stdoutTail,
                        stderrTail: debugCtx.stderrTail,
                        exitCode: debugCtx.exitCode,
                        filesEdited: [...filesEdited],
                        workspaceFiles: workspaceFileList.length > 0 ? workspaceFileList : undefined,
                        fileContents: Object.keys(relevantFileContents).length > 0 ? relevantFileContents : undefined,
                        previousAttempts: previousAttempts.length > 0 ? previousAttempts : undefined,
                      },
                      {
                        apiKey: creds.apiKey,
                        providerId: creds.providerId,
                        model: resolvedModelSlug ?? getModelForProvider(creds.providerId, body.model),
                      }
                    );

                    if (fixSteps.length === 0) {
                      safeEmit( createAgentEvent('reasoning', `No fix proposed in attempt ${attempt}, stopping.`));
                      break;
                    }

                    // Plan lock: only apply fix steps whose path is in approved plan
                    const allowedFixSteps = fixSteps.filter((f) => {
                      const check = isPathAllowed(f.path.trim(), allowedPaths);
                      if (!check.allowed) {
                        safeEmit(createAgentEvent("reasoning", `Plan lock: skipping fix for ${f.path} (not in plan)`));
                        return false;
                      }
                      return validatePathForPlan(f.path.trim()).ok;
                    });

                    safeEmit( createAgentEvent('tool_result', `Auto-fix attempt ${attempt}: applying ${allowedFixSteps.length} edit(s)...`));

                    // Apply fixes to workspace_files (self-debug edits, plan-locked)
                    for (const fixStep of allowedFixSteps) {
                      await applyFileEdit(
                        fixStep.path.trim(),
                        fixStep.newContent,
                        fixStep.oldContent
                      );
                      if (!filesEdited.includes(fixStep.path.trim())) {
                        filesEdited.push(fixStep.path.trim());
                      }
                    }

                    totalFixSteps += fixSteps.length;

                    // Re-run command
                    const retryResult = await executeCommandInWorkspace(supabase, workspaceId, step.command);
                    const retryClassification = classifyCommandResult(retryResult);
                    
                    previousAttempts.push({
                      attempt,
                      steps: fixSteps,
                      result: { status: retryClassification.status, summary: retryClassification.summary },
                    });

                    lastResult = retryResult;
                    lastClassification = retryClassification;

                    if (retryClassification.status === "success") {
                      safeEmit( createAgentEvent('tool_result', `Auto-fix attempt ${attempt} succeeded! Applied ${totalFixSteps} total edit(s).`));
                      commandEntry.autoFixAttempted = true;
                      commandEntry.secondRunStatus = retryClassification.status;
                      commandEntry.secondRunSummary = retryClassification.summary;
                      commandEntry.statusLine = `${firstRunLine}; Auto-fix (attempt ${attempt}): applied ${totalFixSteps} edit(s), passed`;
                      break;
                    } else {
                      safeEmit( createAgentEvent('tool_result', `Auto-fix attempt ${attempt} failed: ${retryClassification.summary}. ${attempt < MAX_DEBUG_ATTEMPTS ? 'Trying again...' : 'Max attempts reached.'}`));
                    }
                  }

                  if (lastClassification.status !== "success") {
                    commandEntry.autoFixAttempted = true;
                    commandEntry.secondRunStatus = lastClassification.status;
                    commandEntry.secondRunSummary = lastClassification.summary;
                    commandEntry.statusLine = `${firstRunLine}; Auto-fix: ${totalFixSteps} edit(s) applied over ${previousAttempts.length} attempt(s), still ${lastClassification.status}`;
                    
                    safeEmit( createAgentEvent('tool_result', `Auto-fix exhausted ${previousAttempts.length} attempt(s), final status: ${lastClassification.status}`, {
                      toolName: 'run_command',
                      command: step.command,
                      stepIndex: i,
                    }));
                  }
                }
              }
            } catch (error) {
              const errKind = classifyCommandKind(step.command);
              safeEmit( createAgentEvent('tool_result', `Command failed: ${error instanceof Error ? error.message : "exception"}`, {
                toolName: 'run_command',
                command: step.command,
                stepIndex: i,
              }));
              log.push({
                stepIndex: i,
                type: "command",
                status: "error",
                message: error instanceof Error ? error.message : "Failed to execute command",
                command: step.command,
                commandKind: errKind,
                commandStatus: "failed",
                commandStatusSummary: "Exception",
                actionLabel: commandKindToActionLabel(errKind),
                statusLine: `${step.command} — failed (${error instanceof Error ? error.message : "exception"})`,
              });
            }
          }
        }

        const commandResults = log.filter((e) => e.type === "command");
        const commandSuccess = commandResults.filter((e) => e.status === "ok").length;
        const commandFailed = commandResults.filter((e) => e.status === "error").length;

        const testEntries = commandResults.filter((e) => e.commandKind === "test");
        const testPassed = testEntries.filter(
          (e) => e.commandStatus === "success" || e.secondRunStatus === "success"
        ).length;
        const testFailed = testEntries.length - testPassed;
        const autoFixTried = testEntries.some((e) => e.autoFixAttempted);
        const autoFixSucceeded = testEntries.some(
          (e) => e.autoFixAttempted && e.secondRunStatus === "success"
        );

        let summary =
          plan.summary ??
          `Completed ${plan.steps.length} step(s). Files edited: ${filesEdited.length}. Commands: ${commandSuccess} succeeded, ${commandFailed} failed.`;

        if (testEntries.length > 0) {
          let testsLine: string;
          if (testFailed === 0) {
            testsLine = autoFixSucceeded
              ? `Tests: ${testPassed} passed (auto-fix succeeded).`
              : `Tests: ${testPassed} passed.`;
          } else {
            testsLine = autoFixTried
              ? `Tests: ${testPassed} passed, ${testFailed} failed (auto-fix tried, still failing).`
              : `Tests: ${testPassed} passed, ${testFailed} failed.`;
          }
          summary += ` ${testsLine}`;
        }

        const conflictEntries = log.filter(
          (e) => e.type === "file_edit" && (e as { conflict?: boolean }).conflict === true
        );
        const filesSkippedDueToConflict = conflictEntries
          .map((e) => (e as { path?: string }).path)
          .filter((p): p is string => !!p);
        if (filesSkippedDueToConflict.length > 0) {
          summary += ` ${filesSkippedDueToConflict.length} edit(s) skipped (file changed since planning).`;
        }

        safeEmit( createAgentEvent('status', 'Execution complete'));

        const result: AgentExecuteResult & {
          sandboxRunId?: string;
          sandboxChecks?: typeof sandboxCheckResults;
          pendingReview?: { fileEdits: { path: string; originalContent: string; newContent: string }[] };
        } = {
          log,
          summary,
          filesEdited,
          ...(filesSkippedDueToConflict.length > 0 ? { filesSkippedDueToConflict } : {}),
          ...(sandboxRunId ? { sandboxRunId } : {}),
          ...(sandboxCheckResults ? { sandboxChecks: sandboxCheckResults } : {}),
          ...(pendingReview ? { pendingReview } : {}),
        };

        if (!closed.current) {
          safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'result', result })}\n\n`);
        }
        safeClose(controller);
      } catch (e) {
        execError = e instanceof Error ? e : new Error(String(e));
        const errorMsg = execError.message;
        logger.error({ event: "execute_error", error: errorMsg, workspaceId, userId: user.id });
        captureException(execError, { workspaceId, operation: "agent_execute", userId: user.id });
        safeEmit(createAgentEvent('status', `Error: ${errorMsg}`));
        if (!closed.current) {
          const errorResult: AgentExecuteResult = {
            log: [],
            summary: `Execution failed: ${errorMsg}`,
            filesEdited: [],
          };
          safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'result', result: errorResult })}\n\n`);
        }
        safeClose(controller);
      } finally {
        releaseStreamSlot(user.id, workspaceId);
        releaseToolSlot(user.id);
        const durationMs = Date.now() - execStart;
        recordAgentExecuteDuration(durationMs);
        logAgentCompleted({
          phase: "execute",
          workspaceId,
          userId: user.id,
          durationMs,
          success: !execError,
          error: execError?.message,
          requestId,
        });
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
