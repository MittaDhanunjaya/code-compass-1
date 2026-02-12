/**
 * Phase 2.1.1: Agent planning service.
 * Extracts business logic from plan route. Route is thin: parse input → call service → return.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, CommandStep, AgentLogEntry, AgentExecuteResult, LogActionLabel } from "@/lib/agent/types";
import { applyEdit } from "@/lib/agent/diff-engine";
import { executeCommandInWorkspace } from "@/lib/agent/execute-command-server";
import { classifyCommandKind, classifyCommandResult } from "@/lib/agent/command-classify";
import { proposeFixSteps, buildTails } from "@/lib/agent/self-debug";
import { getProtectedPaths } from "@/lib/protected-paths";
import { beautifyCode } from "@/lib/utils/code-beautifier";
import type { SearchResult } from "@/lib/indexing/types";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";

const VENV_COMMAND = "python3 -m venv venv";

const PLAN_SYSTEM = `You are a coding agent planner. Given a user instruction and optional workspace context, output a JSON plan only. No markdown, no explanation outside the JSON.

CRITICAL: You MUST output valid JSON only. Use double quotes for all strings, not single quotes. Do not use Python dictionary syntax.

Output a single JSON object with this exact shape:
{
  "steps": [
    { "type": "file_edit", "path": "<file path>", "oldContent": "<exact snippet to replace or omit for full replace>", "newContent": "<new content>", "description": "<optional>" },
    { "type": "command", "command": "<shell command>", "description": "<optional>" }
  ],
  "summary": "<optional short summary>"
}

Rules:
- path must be relative to workspace root (e.g. "src/app/page.tsx").
- For file_edit: include oldContent only when replacing a specific snippet; omit for full file replace.
- Order steps in dependency order (e.g. create file before editing it).
- Use "command" steps for npm install, npm test, etc. Keep commands simple and allowlist-friendly.
- Output ONLY the JSON object, no surrounding text, no markdown code blocks, no Python syntax.
- Create complete projects: README.md, .gitignore, setup commands.
- For Python: python3 -m venv venv first, then venv/bin/pip, venv/bin/python.
- When fixing bugs: minimal edits only, prefer oldContent/newContent.
- RUN INSTRUCTIONS (MANDATORY): README.md or HOW_TO_RUN.txt with concrete steps.`;

function isPythonProject(plan: AgentPlan): boolean {
  for (const step of plan.steps) {
    if (step.type === "file_edit") {
      const p = step.path.toLowerCase();
      if (p.endsWith(".py") || p === "requirements.txt" || p === "pyproject.toml") return true;
    }
    if (step.type === "command") {
      const c = step.command.toLowerCase();
      if (/python3?|pip3?|venv\/bin\/(pip|python)/.test(c)) return true;
    }
  }
  return false;
}

function hasVenvStep(plan: AgentPlan): boolean {
  return plan.steps.some(
    (s) => s.type === "command" && /python3\s+-m\s+venv\s+venv/.test(s.command)
  );
}

function ensurePythonVenvStep(plan: AgentPlan): void {
  if (!isPythonProject(plan) || hasVenvStep(plan)) return;
  const venvStep: CommandStep = {
    type: "command",
    command: VENV_COMMAND,
    description: "Create Python virtual environment",
  };
  const firstCommandIdx = plan.steps.findIndex((s) => s.type === "command");
  if (firstCommandIdx === -1) {
    plan.steps.push(venvStep);
  } else {
    plan.steps.splice(firstCommandIdx, 0, venvStep);
  }
}

export type PlanAgentInput = {
  userId: string;
  instruction: string;
  workspaceId?: string | null;
  provider?: ProviderId;
  model?: string;
  fileList?: string[];
  fileContents?: Record<string, string>;
  useIndex?: boolean;
};

export type PlanAgentResult = {
  plan: AgentPlan;
  provider: ProviderId;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export class PlanAgentError extends Error {
  constructor(
    message: string,
    public readonly code: "no_workspace" | "no_api_key" | "invalid_plan" | "llm_error"
  ) {
    super(message);
    this.name = "PlanAgentError";
  }
}

/**
 * Generate an agent plan from user instruction.
 * Throws PlanAgentError for expected failures (no workspace, no API key, invalid plan).
 */
export async function planAgent(
  supabase: SupabaseClient,
  input: PlanAgentInput
): Promise<PlanAgentResult> {
  const workspaceId = await resolveWorkspaceId(supabase, input.userId, input.workspaceId);
  if (!workspaceId) {
    throw new PlanAgentError("No active workspace selected", "no_workspace");
  }

  const requestedProvider = (input.provider ?? "openrouter") as ProviderId;
  const providersToTry = PROVIDERS.includes(requestedProvider)
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let apiKey: string | null = null;
  let providerId: ProviderId | null = null;

  for (const p of providersToTry) {
    const { data: keyRow, error: keyError } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", input.userId)
      .eq("provider", p)
      .maybeSingle();

    if (keyError) continue;
    if (keyRow?.key_encrypted) {
      try {
        apiKey = decrypt(keyRow.key_encrypted);
        providerId = p;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!apiKey || !providerId) {
    const triedLabels = providersToTry.map((p) => PROVIDER_LABELS[p]).join(", ");
    throw new PlanAgentError(
      `No API key configured. Tried: ${triedLabels}. Add a key in Settings → API Keys.`,
      "no_api_key"
    );
  }

  let userContent = `Instruction: ${input.instruction}`;

  let indexedFiles: SearchResult[] = [];
  if (input.useIndex && workspaceId) {
    try {
      const searchTerms = input.instruction
        .split(/\s+/)
        .filter((w) => w.length > 3 && !/^(the|and|or|for|with|from)$/i.test(w))
        .slice(0, 3)
        .join(" ");
      if (searchTerms) {
        const { data: chunks } = await supabase
          .from("code_chunks")
          .select("file_path, content, symbols, chunk_index")
          .eq("workspace_id", workspaceId)
          .ilike("content", `%${searchTerms}%`)
          .limit(15);
        if (chunks) {
          const queryLower = searchTerms.toLowerCase();
          const resultsMap = new Map<string, SearchResult>();
          for (const chunk of chunks) {
            const path = chunk.file_path;
            const content = chunk.content ?? "";
            const lines = content.split("\n");
            let matchLine: number | undefined;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(queryLower)) {
                matchLine = i + 1;
                break;
              }
            }
            const previewStart = Math.max(0, (matchLine ?? 1) - 2);
            const previewEnd = Math.min(lines.length, previewStart + 5);
            const preview = lines.slice(previewStart, previewEnd).join("\n");
            if (!resultsMap.has(path)) {
              resultsMap.set(path, { path, line: matchLine, preview: preview.slice(0, 500) });
            }
          }
          indexedFiles = Array.from(resultsMap.values()).slice(0, 5);
        }
      }
    } catch {
      // Index search failed, continue without
    }
  }

  if (input.fileList?.length) {
    userContent += `\n\nFiles in workspace (paths):\n${input.fileList.join("\n")}`;
  }
  if (indexedFiles.length > 0) {
    userContent += "\n\nRelevant codebase context (from index):\n";
    for (const r of indexedFiles) {
      userContent += `\n--- ${r.path}${r.line ? ` (line ${r.line})` : ""} ---\n${r.preview}\n`;
    }
  }
  if (input.fileContents && Object.keys(input.fileContents).length > 0) {
    userContent += "\n\nRelevant file contents (path -> content):\n";
    for (const [path, content] of Object.entries(input.fileContents)) {
      userContent += `\n--- ${path} ---\n${content.slice(0, 8000)}\n`;
    }
  }

  const rules = await loadRules(supabase, workspaceId);
  const rulesPrompt = formatRulesForPrompt(rules);
  const systemPromptWithRules = PLAN_SYSTEM + rulesPrompt;

  const provider = getProvider(providerId);
  const modelOpt = getModelForProvider(providerId, input.model);
  const { content: raw, usage } = await provider.chat(
    [
      { role: "system", content: systemPromptWithRules },
      { role: "user", content: userContent },
    ],
    apiKey,
    { model: modelOpt }
  );

  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("{") &&
    !trimmed.startsWith("[") &&
    !trimmed.includes('"steps"') &&
    !trimmed.includes("'steps'")
  ) {
    if (
      trimmed.includes("margin:") ||
      trimmed.includes("font-family:") ||
      trimmed.includes("def ") ||
      trimmed.includes("function ") ||
      trimmed.includes("import ") ||
      trimmed.includes("const ") ||
      trimmed.includes("class ")
    ) {
      throw new PlanAgentError(
        `LLM returned code instead of JSON. Rephrase as a clear task request.`,
        "llm_error"
      );
    }
  }

  let jsonStr = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/g, "");
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new PlanAgentError("LLM did not return valid JSON with steps array.", "llm_error");
  }
  jsonStr = jsonMatch[0];

  if (jsonStr.includes("'") && !jsonStr.includes('"')) {
    jsonStr = jsonStr
      .replace(/'/g, '"')
      .replace(/True/g, "true")
      .replace(/False/g, "false")
      .replace(/None/g, "null");
  }

  let plan: AgentPlan;
  try {
    plan = JSON.parse(jsonStr) as AgentPlan;
  } catch (e) {
    throw new PlanAgentError(
      `Failed to parse JSON: ${e instanceof Error ? e.message : "Unknown"}`,
      "invalid_plan"
    );
  }

  if (!plan || !Array.isArray(plan.steps)) {
    throw new PlanAgentError("LLM did not return a valid plan (missing steps array)", "invalid_plan");
  }

  for (const step of plan.steps) {
    if (step.type === "file_edit") {
      if (!step.path || typeof step.newContent !== "string") {
        throw new PlanAgentError("Invalid file_edit step: path and newContent required", "invalid_plan");
      }
    } else if (step.type === "command") {
      if (!step.command || typeof step.command !== "string") {
        throw new PlanAgentError("Invalid command step: command required", "invalid_plan");
      }
    }
  }

  ensurePythonVenvStep(plan);

  return {
    plan,
    provider: providerId,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        }
      : undefined,
  };
}

// --- Phase 2.1.2: Agent execution service ---

function commandKindToActionLabel(kind: "setup" | "test" | "other"): LogActionLabel {
  if (kind === "setup") return "CMD-SETUP";
  if (kind === "test") return "CMD-TEST";
  return "CMD-OTHER";
}

export type ExecuteAgentInput = {
  plan: AgentPlan;
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  provider?: ProviderId;
  model?: string;
  confirmedProtectedPaths?: string[];
};

export type ExecuteAgentResult =
  | { ok: true; result: AgentExecuteResult }
  | { ok: false; needProtectedConfirmation: true; protectedPaths: string[] };

/**
 * Execute an agent plan (non-streaming). Applies file edits and runs commands.
 * Returns needProtectedConfirmation when protected paths require user confirmation.
 */
export async function executeAgentPlan(input: ExecuteAgentInput): Promise<ExecuteAgentResult> {
  const { plan, workspaceId, userId, supabase, provider = "openrouter", model, confirmedProtectedPaths = [] } = input;
  const confirmedSet = new Set(confirmedProtectedPaths.map((p) => p.trim()).filter(Boolean));

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, safe_edit_mode")
    .eq("id", workspaceId)
    .eq("owner_id", userId)
    .single();

  if (!workspace) {
    throw new PlanAgentError("Workspace not found", "no_workspace");
  }

  const safeEditMode = workspace.safe_edit_mode !== false;
  const fileEditPaths = plan.steps
    .filter((s): s is typeof s & { type: "file_edit" } => s.type === "file_edit")
    .map((s) => s.path.trim());
  const protectedPaths = getProtectedPaths(fileEditPaths);

  if (safeEditMode && protectedPaths.length > 0) {
    const allConfirmed = protectedPaths.every((p) => confirmedSet.has(p));
    if (!allConfirmed) {
      return { ok: false, needProtectedConfirmation: true, protectedPaths };
    }
  }

  const log: AgentLogEntry[] = [];
  const filesEdited: string[] = [];
  const filesSkippedDueToConflict: string[] = [];

  let selfDebugApiKey: string | null = null;
  let selfDebugProviderId: ProviderId | null = null;
  const getSelfDebugApiKey = async (): Promise<{ apiKey: string; providerId: ProviderId } | null> => {
    if (selfDebugApiKey && selfDebugProviderId) return { apiKey: selfDebugApiKey, providerId: selfDebugProviderId };
    const providersToTry = PROVIDERS.includes(provider)
      ? [provider, ...PROVIDERS.filter((p) => p !== provider)]
      : [...PROVIDERS];
    for (const p of providersToTry) {
      const { data: keyRow } = await supabase
        .from("provider_keys")
        .select("key_encrypted")
        .eq("user_id", userId)
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
        .insert({ workspace_id: workspaceId, path, content: newContent });
      if (!error && !filesEdited.includes(path)) filesEdited.push(path);
      return !error;
    }

    const currentContent = fileRow.content ?? "";
    const result = applyEdit(currentContent, newContent, oldContent);
    if (!result.ok) return false;

    const { error } = await supabase
      .from("workspace_files")
      .update({ content: result.content, updated_at: new Date().toISOString() })
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
        const beautifiedContent = beautifyCode(step.newContent, path);
        const { error: insertError } = await supabase
          .from("workspace_files")
          .insert({ workspace_id: workspaceId, path, content: beautifiedContent });

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
      const beautifiedNewContent = beautifyCode(step.newContent, path);
      let oldContentToMatch = step.oldContent;
      let contentToMatchAgainst = currentContent;

      if (oldContentToMatch) {
        const beautifiedOldContent = beautifyCode(oldContentToMatch, path);
        const beautifiedCurrentContent = beautifyCode(currentContent, path);
        if (beautifiedCurrentContent.includes(beautifiedOldContent)) {
          oldContentToMatch = beautifiedOldContent;
          contentToMatchAgainst = beautifiedCurrentContent;
        }
      }

      const result = applyEdit(contentToMatchAgainst, beautifiedNewContent, oldContentToMatch);

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
        .update({ content: result.content, updated_at: new Date().toISOString() })
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

        if (commandKind === "test" && classification.status === "failed") {
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
                model: getModelForProvider(creds.providerId, model),
              }
            );

            for (const fixStep of fixSteps) {
              await applyFileEdit(fixStep.path.trim(), fixStep.newContent, fixStep.oldContent);
            }

            const secondResult = await executeCommandInWorkspace(supabase, workspaceId, step.command);
            const secondClassification = classifyCommandResult(secondResult);

            commandEntry.autoFixAttempted = true;
            commandEntry.secondRunStatus = secondClassification.status;
            commandEntry.secondRunSummary = secondClassification.summary;
            const editCount = fixSteps.length;
            const secondLine =
              secondClassification.status === "success"
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
    const testsLine =
      testFailed === 0
        ? autoFixSucceeded
          ? `Tests: ${testPassed} passed (auto-fix succeeded).`
          : `Tests: ${testPassed} passed.`
        : autoFixTried
          ? `Tests: ${testPassed} passed, ${testFailed} failed (auto-fix tried, still failing).`
          : `Tests: ${testPassed} passed, ${testFailed} failed.`;
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

  return { ok: true, result };
}
