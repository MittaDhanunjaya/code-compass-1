import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, AgentLogEntry, AgentExecuteResult, LogActionLabel } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { executeCommandInWorkspace } from "@/lib/agent/execute-command-server";
import { classifyCommandKind, classifyCommandResult } from "@/lib/agent/command-classify";
import { proposeFixSteps, buildTails } from "@/lib/agent/self-debug";
import { getProtectedPaths } from "@/lib/protected-paths";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { beautifyCode } from "@/lib/utils/code-beautifier";

function commandKindToActionLabel(kind: "setup" | "test" | "other"): LogActionLabel {
  if (kind === "setup") return "CMD-SETUP";
  if (kind === "test") return "CMD-TEST";
  return "CMD-OTHER";
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { workspaceId?: string; plan?: AgentPlan; provider?: ProviderId; model?: string; confirmedProtectedPaths?: string[] };
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

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId || !plan?.steps?.length) {
    return NextResponse.json(
      { error: !workspaceId ? "No active workspace selected" : "plan with steps is required" },
      { status: 400 }
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, safe_edit_mode")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const safeEditMode = workspace.safe_edit_mode !== false;
  const fileEditPaths = plan.steps.filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit").map((s) => s.path.trim());
  const protectedPaths = getProtectedPaths(fileEditPaths);

  if (safeEditMode && protectedPaths.length > 0) {
    const allConfirmed = protectedPaths.every((p) => confirmedProtectedPaths.has(p));
    if (!allConfirmed) {
      return NextResponse.json({
        needProtectedConfirmation: true,
        protectedPaths,
      });
    }
  }

  const log: AgentLogEntry[] = [];
  const filesEdited: string[] = [];
  const filesSkippedDueToConflict: string[] = [];

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

  /** Apply a single file_edit step to DB (same logic as plan file_edit). */
  const applyFileEdit = async (
    path: string,
    newContent: string,
    oldContent?: string
  ): Promise<boolean> => {
    const { data: fileRow } = await supabase
      .from("workspace_files")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .single();

    if (!fileRow) {
      const { error } = await supabase
        .from("workspace_files")
        .insert({
          workspace_id: workspaceId,
          path,
          content: newContent,
        });
      if (!error && !filesEdited.includes(path)) filesEdited.push(path);
      return !error;
    }

    const currentContent = fileRow.content ?? "";
    const result = applyEdit(currentContent, newContent, oldContent);
    if (!result.ok) return false;

    const { error } = await supabase
      .from("workspace_files")
      .update({
        content: result.content,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("path", path);

    if (!error && !filesEdited.includes(path)) filesEdited.push(path);
    return !error;
  };

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    if (step.type === "file_edit") {
      const path = step.path.trim();
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
        filesSkippedDueToConflict.push(path);
        log.push({
          stepIndex: i,
          type: "file_edit",
          status: "error",
          message: result.error,
          path,
          actionLabel: "EDIT",
          statusLine: `Edit failed: ${path} — ${result.error}`,
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

        // v1 self-debug: one auto-fix attempt for failed test commands only
        if (
          commandKind === "test" &&
          classification.status === "failed"
        ) {
          const creds = await getSelfDebugApiKey();
          if (creds) {
            log.push({
              stepIndex: i,
              type: "info",
              message: "Auto-fixing failed tests…",
              actionLabel: "AUTO-FIX",
              statusLine: "Auto-fixing failed tests…",
            });

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
          }
        }
      } catch (error) {
        const errKind = classifyCommandKind(step.command);
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
  if (filesSkippedDueToConflict.length > 0) {
    summary += ` ${filesSkippedDueToConflict.length} edit(s) skipped (file changed since planning).`;
  }

  const result: AgentExecuteResult = {
    log,
    summary,
    filesEdited,
    ...(filesSkippedDueToConflict.length > 0 ? { filesSkippedDueToConflict } : {}),
  };

  return NextResponse.json(result);
}
