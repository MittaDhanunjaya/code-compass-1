import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, AgentLogEntry, AgentExecuteResult } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { executeCommandInWorkspace } from "@/lib/agent/execute-command-server";
import { classifyCommandKind, classifyCommandResult } from "@/lib/agent/command-classify";
import { proposeFixSteps, buildTails } from "@/lib/agent/self-debug";
import { getProtectedPaths } from "@/lib/protected-paths";
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

  let body: { workspaceId?: string; plan?: AgentPlan; provider?: ProviderId; model?: string; confirmedProtectedPaths?: string[]; skipProtected?: boolean };
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'result', result: errorResult })}\n\n`));
          controller.close();
          return;
        }

        if (!workspace) {
          safeEmit( createAgentEvent('status', 'Error: Workspace not found'));
          const errorResult: AgentExecuteResult = {
            log: [],
            summary: "Error: Workspace not found or you don't have access to it",
            filesEdited: [],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'result', result: errorResult })}\n\n`));
          controller.close();
          return;
        }

        // Default to safe mode if column doesn't exist
        const safeEditMode = (workspace as any).safe_edit_mode !== false;
        const fileEditPaths = plan.steps.filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit").map((s) => s.path.trim());
        const protectedPaths = getProtectedPaths(fileEditPaths);

        const protectedSet = new Set(protectedPaths);
        if (safeEditMode && protectedPaths.length > 0) {
          const allConfirmed = protectedPaths.every((p) => confirmedProtectedPaths.has(p));
          if (!skipProtected && !allConfirmed) {
            safeEmit( createAgentEvent('status', 'Error: Protected files require confirmation'));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'needProtectedConfirmation', protectedPaths })}\n\n`));
            controller.close();
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

        let sandboxRunId: string | null = null;
        let sandboxChecksPassed = false;
        let sandboxCheckResults: { lint: { passed: boolean; logs: string }; tests: { passed: boolean; logs: string } } | null = null;

        // Process file edits through sandbox if any exist
        if (fileEditSteps.length > 0) {
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

            // Apply edits to sandbox
            const sandboxResult = await applyEditsToSandbox(supabase, sandboxRunId, fileEditSteps);

            // Log sandbox edit results
            for (let i = 0; i < fileEditSteps.length; i++) {
              const step = fileEditSteps[i];
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
                safeEmit( createAgentEvent('status', 'All sandbox checks passed. Application verified working. Applying changes to workspace...'));
              } else if (runStatus === "passed") {
                safeEmit( createAgentEvent('status', 'Application runs successfully. Applying changes to workspace...'));
              } else {
                safeEmit( createAgentEvent('status', 'Sandbox checks skipped/not configured. Applying changes to workspace...'));
              }
              
              // Promote sandbox to workspace
              const promoteResult = await promoteSandboxToWorkspace(supabase, sandboxRunId);
              filesEdited.push(...promoteResult.filesEdited);
              
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
                // Lint/test failures - still promote but warn (app runs, just has code quality issues)
                safeEmit( createAgentEvent('status', 'Sandbox checks failed (lint/tests). Application runs, but changes will still be applied. Please review errors.'));
                
                // Promote sandbox to workspace (app runs, just has quality issues)
                const promoteResult = await promoteSandboxToWorkspace(supabase, sandboxRunId);
                filesEdited.push(...promoteResult.filesEdited);
                
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
        const getSelfDebugApiKey = async (): Promise<{ apiKey: string; providerId: ProviderId } | null> => {
          if (selfDebugApiKey && selfDebugProviderId) return { apiKey: selfDebugApiKey, providerId: selfDebugProviderId };
          const providersToTry = PROVIDERS.includes(requestedProvider)
            ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
            : [...PROVIDERS];
          for (const p of providersToTry) {
            const { data: keyRow } = await supabase
              .from("provider_keys")
              .select("key_encrypted")
              .eq("user_id", user.id)
              .eq("provider", p)
              .single();
            if (keyRow?.key_encrypted) {
              try {
                const apiKey = decrypt(keyRow.key_encrypted);
                selfDebugApiKey = apiKey;
                selfDebugProviderId = p;
                return { apiKey, providerId: p };
              } catch {
                continue;
              }
            }
          }
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
              const { error: insertError } = await supabase
                .from("workspace_files")
                .insert({
                  workspace_id: workspaceId,
                  path,
                  content: step.newContent,
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
            const result = applyEdit(
              currentContent,
              step.newContent,
              step.oldContent
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

              // v1 self-debug: one auto-fix attempt for failed test commands only
              if (
                commandKind === "test" &&
                classification.status === "failed"
              ) {
                safeEmit( createAgentEvent('reasoning', 'Auto-fixing failed tests...'));
                const creds = await getSelfDebugApiKey();
                if (creds) {
                  const { stdoutTail, stderrTail } = buildTails(cmdResult.stdout ?? "", cmdResult.stderr ?? "");
                  const fixSteps = await proposeFixSteps(
                    {
                      command: step.command,
                      stdoutTail,
                      stderrTail,
                      filesEdited: [...filesEdited],
                    },
                    {
                      apiKey: creds.apiKey,
                      providerId: creds.providerId,
                      model: getModelForProvider(creds.providerId, body.model),
                    }
                  );

                  safeEmit( createAgentEvent('tool_result', `Auto-fix: applying ${fixSteps.length} edit(s)...`));

                  for (const fixStep of fixSteps) {
                    await applyFileEdit(
                      fixStep.path.trim(),
                      fixStep.newContent,
                      fixStep.oldContent
                    );
                  }

                  const secondResult = await executeCommandInWorkspace(supabase, workspaceId, step.command);
                  const secondClassification = classifyCommandResult(secondResult);

                  commandEntry.autoFixAttempted = true;
                  commandEntry.secondRunStatus = secondClassification.status;
                  commandEntry.secondRunSummary = secondClassification.summary;
                  const editCount = fixSteps.length;
                  const secondLine = secondClassification.status === "success"
                    ? `Auto-fix applied ${editCount} edit(s), second run passed`
                    : `Auto-fix applied ${editCount} edit(s), second run: ${secondClassification.status} (${secondClassification.summary})`;
                  commandEntry.statusLine = `${firstRunLine}; ${secondLine}`;
                  
                  safeEmit( createAgentEvent('tool_result', secondLine, {
                    toolName: 'run_command',
                    command: step.command,
                    stepIndex: i,
                  }));
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

        const result: AgentExecuteResult & { sandboxRunId?: string; sandboxChecks?: typeof sandboxCheckResults } = {
          log,
          summary,
          filesEdited,
          ...(filesSkippedDueToConflict.length > 0 ? { filesSkippedDueToConflict } : {}),
          ...(sandboxRunId ? { sandboxRunId } : {}),
          ...(sandboxCheckResults ? { sandboxChecks: sandboxCheckResults } : {}),
        };

        if (!closed.current) {
          try {
            const resultData = `data: ${JSON.stringify({ type: 'result', result })}\n\n`;
            controller.enqueue(encoder.encode(resultData));
          } catch (enqueueError) {
            if (isStreamClosed(enqueueError)) closed.current = true;
            else console.error("Failed to enqueue result:", enqueueError);
          }
        }
        if (!closed.current) {
          try {
            controller.close();
          } catch (_) {
            closed.current = true;
          }
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Execution failed";
        safeEmit(createAgentEvent('status', `Error: ${errorMsg}`));

        if (!closed.current) {
          try {
            const errorResult: AgentExecuteResult = {
              log: [],
              summary: `Execution failed: ${errorMsg}`,
              filesEdited: [],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'result', result: errorResult })}\n\n`));
          } catch (enqueueError) {
            if (isStreamClosed(enqueueError)) closed.current = true;
            else console.error("Failed to enqueue error result:", enqueueError);
          }
        }
        if (!closed.current) {
          try {
            controller.close();
          } catch (_) {
            closed.current = true;
          }
        }
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
