import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, AgentLogEntry, AgentExecuteResult } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { executeCommandInWorkspace } from "@/lib/agent/execute-command-server";
import { classifyCommandKind, classifyCommandResult } from "@/lib/agent/command-classify";
import { proposeFixSteps, buildTails } from "@/lib/agent/self-debug";
import { extractPortFromError, findAvailablePort } from "@/lib/agent/port-utils";
import { buildIntelligentContext } from "@/lib/indexing/intelligent-context";
import { getProtectedPaths } from "@/lib/protected-paths";
import { checkEditGuardrail, getGuardrailMode } from "@/lib/agent/guardrails";
import { createAgentEvent, formatStreamEvent, type AgentEvent } from "@/lib/agent-events";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import {
  createSandboxFromWorkspace,
  applyEditsToSandbox,
  promoteSandboxToWorkspace,
  runSandboxChecks,
  syncSandboxToDisk,
  getSandboxDir,
  type SandboxSource,
} from "@/lib/sandbox";
import { beautifyCode } from "@/lib/utils/code-beautifier";
import { safeEnqueue, safeClose } from "@/lib/stream-utils";

function commandKindToActionLabel(kind: "setup" | "test" | "other"): string {
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
      console.error("Failed to emit event:", e);
    }
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { workspaceId?: string; plan?: AgentPlan; provider?: ProviderId; model?: string; modelId?: string; modelGroupId?: string; confirmedProtectedPaths?: string[]; skipProtected?: boolean; scopeMode?: "conservative" | "normal" | "aggressive"; confirmedAggressive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const plan = body.plan;
  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const confirmedProtectedPaths = new Set((body.confirmedProtectedPaths ?? []).map((p) => p.trim()).filter(Boolean));
  const skipProtected = body.skipProtected === true;

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId || !plan?.steps?.length) {
    return NextResponse.json(
      { error: !workspaceId ? "No active workspace selected" : "plan with steps is required" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const closed = { current: false };
      const safeEmit = (event: AgentEvent) => emitEvent(controller, encoder, event, closed);

      try {
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
            workspace = minimalRetry.data;
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
        const safeEditMode = (workspace as any).safe_edit_mode !== false;
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

        safeEmit( createAgentEvent('reasoning', `Executing ${plan.steps.length} step(s)...`));

        // Separate file_edit steps from command steps for sandbox processing
        const fileEditSteps = plan.steps.filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit");
        const commandSteps = plan.steps.filter((s): s is typeof s & { type: "command" } => s.type === "command");

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
        let sandboxCheckResults: { lint: { passed: boolean; logs: string }; tests: { passed: boolean; logs: string } } | null = null;
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
            safeEmit( createAgentEvent('status', 'Running lint in sandbox...'));
            safeEmit( createAgentEvent('tool_call', 'Running lint check', {
              toolName: 'run_command',
              command: 'npm run lint',
            }));

            // Create command executor for sandbox
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
                
                // Log any conflicts during promotion
                for (const conflict of promoteResult.conflicts) {
                  log.push({
                    stepIndex: -1,
                    type: "file_edit",
                    status: "error",
                    message: conflict.message,
                    path: conflict.path,
                    actionLabel: "EDIT",
                    statusLine: `Promotion conflict: ${conflict.path}`,
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
        for (let i = 0; i < plan.steps.length; i++) {
          const step = plan.steps[i];

          // Skip file_edit steps - they were already processed through sandbox above
          if (step.type === "file_edit") {
            continue;
          }

          if (false) { // Removed old file_edit handling
            const path = step.path.trim();
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

            // Re-read current content immediately before apply to avoid applying against stale state
            const { data: fileRow } = await supabase
              .from("workspace_files")
              .select("content")
              .eq("workspace_id", workspaceId)
              .eq("path", path)
              .single();

            if (!fileRow) {
              // Beautify code before writing (convert \n to actual newlines, etc.)
              const beautifiedContent = beautifyCode(step.newContent, path);
              
              const { error: insertError } = await supabase
                .from("workspace_files")
                .insert({
                  workspace_id: workspaceId,
                  path,
                  content: beautifiedContent,
                });

              if (insertError) {
                safeEmit( createAgentEvent('tool_result', `Failed to create ${path}: ${insertError.message}`, {
                  toolName: 'edit_file',
                  filePath: path,
                  stepIndex: i,
                }));
                log.push({
                  stepIndex: i,
                  type: "file_edit",
                  status: "error",
                  message: insertError.message,
                  path,
                  actionLabel: "EDIT",
                  statusLine: `Error creating ${path}: ${insertError.message}`,
                });
              } else {
                if (!filesEdited.includes(path)) filesEdited.push(path);
                safeEmit( createAgentEvent('tool_result', `Created ${path}`, {
                  toolName: 'edit_file',
                  filePath: path,
                  stepIndex: i,
                }));
                log.push({
                  stepIndex: i,
                  type: "file_edit",
                  status: "ok",
                  message: step.description ?? `Created ${path}`,
                  path,
                  actionLabel: "EDIT",
                  statusLine: `Created ${path}`,
                });
              }
              continue;
            }

            const currentContent = fileRow.content ?? "";
            // Beautify new content before applying edit (convert \n to actual newlines, etc.)
            const beautifiedNewContent = beautifyCode(step.newContent, path);
            
            // IMPORTANT: Don't beautify oldContent directly - it needs to match the actual file content
            // The oldContent from the plan might have escaped newlines, but the actual file
            // content in the database might already be beautified. We need to match what's actually there.
            let oldContentToMatch = step.oldContent;
            let contentToMatchAgainst = currentContent;
            
            // If oldContent is provided, beautify both for comparison
            if (oldContentToMatch) {
              const beautifiedOldContent = beautifyCode(oldContentToMatch, path);
              const beautifiedCurrentContent = beautifyCode(currentContent, path);
              // Try matching with beautified versions first
              if (beautifiedCurrentContent.includes(beautifiedOldContent)) {
                oldContentToMatch = beautifiedOldContent;
                contentToMatchAgainst = beautifiedCurrentContent;
              }
            }
            
            const result = applyEdit(
              contentToMatchAgainst,
              beautifiedNewContent,
              oldContentToMatch
            );

            if (!result.ok) {
              const conflictMessage =
                "Edit conflict: file changed since planning. Please review manually or re-run with updated context.";
              safeEmit( createAgentEvent('status', conflictMessage, { filePath: path }));
              safeEmit( createAgentEvent('tool_result', `Edit failed: ${path} — ${result.error}`, {
                toolName: 'edit_file',
                filePath: path,
                stepIndex: i,
                conflict: true,
              }));
              log.push({
                stepIndex: i,
                type: "file_edit",
                status: "error",
                message: result.error,
                path,
                actionLabel: "EDIT",
                statusLine: `Edit failed: ${path} — ${result.error}`,
                conflict: true,
              });
              continue;
            }

            const { error } = await supabase
              .from("workspace_files")
              .update({
                content: result.content,
                updated_at: new Date().toISOString(),
              })
              .eq("workspace_id", workspaceId)
              .eq("path", path);

            if (error) {
              safeEmit( createAgentEvent('tool_result', `Error saving ${path}: ${error.message}`, {
                toolName: 'edit_file',
                filePath: path,
                stepIndex: i,
              }));
              log.push({
                stepIndex: i,
                type: "file_edit",
                status: "error",
                message: error.message,
                path,
                actionLabel: "EDIT",
                statusLine: `Error saving ${path}: ${error.message}`,
              });
            } else {
              if (!filesEdited.includes(path)) filesEdited.push(path);
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
            }
          } else if (step.type === "command") {
            const commandKind = classifyCommandKind(step.command);
            safeEmit( createAgentEvent('tool_call', `Running command: ${step.command}`, {
              toolName: 'run_command',
              command: step.command,
              stepIndex: i,
            }));

            try {
              const cmdResult = await executeCommandInWorkspace(supabase, workspaceId, step.command);
              const classification = classifyCommandResult(cmdResult);

              let status: "ok" | "skipped" | "error" = classification.status === "success" ? "ok" : "error";
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

              // Enhanced self-debug: multiple retry attempts for failed commands
              // Trigger for: test/setup failures, port conflicts, and other runtime errors
              const MAX_DEBUG_ATTEMPTS = 5;
              const isPortConflict = (cmdResult.stderr?.toLowerCase().includes("port") && cmdResult.stderr?.toLowerCase().includes("already in use")) ||
                                     (cmdResult.stdout?.toLowerCase().includes("port") && cmdResult.stdout?.toLowerCase().includes("already in use")) ||
                                     cmdResult.stderr?.toLowerCase().includes("eaddrinuse");
              
              if (
                classification.status === "failed" &&
                ((commandKind === "test" || commandKind === "setup") || isPortConflict)
              ) {
                const creds = await getSelfDebugApiKey();
                if (creds) {
                  const previousAttempts: Array<{
                    attempt: number;
                    steps: typeof fixSteps;
                    result: { status: string; summary: string };
                  }> = [];
                  
                  let lastResult = cmdResult;
                  let lastClassification = classification;
                  let totalFixSteps = 0;
                  
                  // Build intelligent context automatically (discovers relevant files based on codebase structure)
                  let workspaceFileList: string[] = [];
                  let relevantFileContents: Record<string, string> = {};
                  
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
                    
                    const { stdoutTail, stderrTail } = buildTails(lastResult.stdout ?? "", lastResult.stderr ?? "");
                    const fixSteps = await proposeFixSteps(
                      {
                        command: step.command,
                        stdoutTail,
                        stderrTail,
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

                    safeEmit( createAgentEvent('tool_result', `Auto-fix attempt ${attempt}: applying ${fixSteps.length} edit(s)...`));

                    // Apply fixes
                    for (const fixStep of fixSteps) {
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
        const errorMsg = e instanceof Error ? e.message : "Execution failed";
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
