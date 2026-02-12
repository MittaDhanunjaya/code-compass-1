/**
 * Phase 2.1.4: Composer service.
 * Extracts business logic from composer routes.
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import { hashForCache } from "@/lib/cache";
import { getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { invokeChat } from "@/lib/llm/router";
import type { FileEditStep } from "@/lib/agent/types";
import { applyScopeCaps } from "@/lib/agent/scope";
import type { ComposerPlan, ComposerScope } from "@/lib/composer/types";
import type { SearchResult } from "@/lib/indexing/types";
import { getProtectedPaths } from "@/lib/protected-paths";
import {
  createSandboxFromWorkspace,
  applyEditsToSandbox,
  promoteSandboxToWorkspace,
  runSandboxChecks,
  syncSandboxToDisk,
  type SandboxCheckResult,
  type SandboxRunMetadata,
} from "@/lib/sandbox";
import { recordModelOutcome } from "@/lib/llm/ab-stats";
import { runDebugFromLog } from "@/lib/debug-from-log-core";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { parseJSONRobust } from "@/lib/utils/json-parser";

const WORKSPACE_FILE_CAP = 20;

const COMPOSER_SYSTEM = `You are a multi-file code editor. Given an edit instruction and a list of candidate files (with optional content), output a JSON plan with ONLY file_edit steps. No commands, no explanations outside the JSON.

CRITICAL: You MUST output valid JSON only. Use double quotes for all strings. Do not use Python dictionary syntax.

Output a single JSON object with this exact shape:
{
  "steps": [
    { "type": "file_edit", "path": "<file path>", "oldContent": "<exact snippet to replace or omit for full replace>", "newContent": "<new content>", "description": "<optional>" }
  ],
  "summary": "<optional short summary>"
}

Rules:
- path must be one of the candidate file paths provided; do not invent paths.
- For file_edit: include oldContent only when replacing a specific snippet; omit for full file replace.
- Order steps in dependency order if one edit depends on another.
- Output ONLY file_edit steps. No "command" steps.
- Output ONLY the JSON object, no surrounding text, no markdown code blocks.`;

function getDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

export type PlanComposerInput = {
  instruction: string;
  scope: ComposerScope;
  currentFilePath?: string | null;
  scopeMode?: "normal" | "conservative" | "aggressive";
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  provider?: ProviderId;
  model?: string;
  fileContents?: Record<string, string>;
};

export type PlanComposerResult = {
  plan: ComposerPlan;
  stepsWithContent: { path: string; originalContent: string; newContent: string; oldContent?: string; description?: string }[];
  provider: ProviderId;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

export class ComposerPlanError extends Error {
  constructor(
    message: string,
    public readonly code: "no_workspace" | "no_api_key" | "invalid_plan" | "llm_error"
  ) {
    super(message);
    this.name = "ComposerPlanError";
  }
}

/**
 * Generate a composer plan from instruction and scope.
 */
export async function planComposer(input: PlanComposerInput): Promise<PlanComposerResult> {
  const {
    instruction,
    scope,
    currentFilePath,
    scopeMode = "normal",
    workspaceId,
    userId,
    supabase,
    provider = "openrouter",
    model,
    fileContents: fromFrontend = {},
  } = input;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_id", userId)
    .single();

  if (!workspace) {
    throw new ComposerPlanError("Workspace not found", "no_workspace");
  }

  const { data: allFiles, error: listError } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .order("path", { ascending: true });

  if (listError) {
    throw new ComposerPlanError(listError.message, "llm_error");
  }

  const paths = (allFiles ?? []).map((r) => r.path);
  let candidatePaths: string[] = [];

  if (scope === "current_file") {
    if (!currentFilePath) throw new ComposerPlanError("currentFilePath is required for scope 'current_file'", "invalid_plan");
    if (!paths.includes(currentFilePath)) throw new ComposerPlanError("Current file is not in workspace", "invalid_plan");
    candidatePaths = [currentFilePath];
  } else if (scope === "current_folder") {
    if (!currentFilePath) throw new ComposerPlanError("currentFilePath is required for scope 'current_folder'", "invalid_plan");
    const dir = getDir(currentFilePath);
    candidatePaths = paths.filter((p) => p === currentFilePath || p.startsWith(dir));
    if (candidatePaths.length > WORKSPACE_FILE_CAP) candidatePaths = candidatePaths.slice(0, WORKSPACE_FILE_CAP);
  } else {
    candidatePaths = paths.slice(0, WORKSPACE_FILE_CAP);
  }

  if (candidatePaths.length === 0) {
    throw new ComposerPlanError("No candidate files in scope", "invalid_plan");
  }

  let indexedFiles: SearchResult[] = [];
  const searchTerms = instruction
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(the|and|or|for|with|from)$/i.test(w))
    .slice(0, 3)
    .join(" ");
  if (searchTerms) {
    try {
      const { data: chunks } = await supabase
        .from("code_chunks")
        .select("file_path, content, chunk_index")
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
    } catch {
      // ignore
    }
  }

  const fileContents: Record<string, string> = {};
  const filesMeta = allFiles ?? [];
  for (const path of candidatePaths) {
    if (fromFrontend[path] != null) {
      fileContents[path] = String(fromFrontend[path]).slice(0, 8000);
    } else {
      const row = filesMeta.find((r) => r.path === path);
      if (row) fileContents[path] = (row.content ?? "").slice(0, 8000);
    }
  }

  const requestedProvider = provider as ProviderId;
  const providersToTry = PROVIDERS.includes(requestedProvider)
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let apiKey: string | null = null;
  let providerId: ProviderId | null = null;
  for (const p of providersToTry) {
    const { data: keyRow, error } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", userId)
      .eq("provider", p)
      .maybeSingle();
    if (error || !keyRow?.key_encrypted) continue;
    try {
      apiKey = decrypt(keyRow.key_encrypted);
      providerId = p;
      break;
    } catch {
      continue;
    }
  }

  if (!apiKey || !providerId) {
    const triedLabels = providersToTry.map((p) => PROVIDER_LABELS[p]).join(", ");
    throw new ComposerPlanError(
      `No API key configured. Tried: ${triedLabels}. Add one in Settings → API Keys.`,
      "no_api_key"
    );
  }

  let userContent = `Instruction: ${instruction}\n\nCandidate file paths (you may only edit these):\n${candidatePaths.join("\n")}`;
  if (indexedFiles.length > 0) {
    userContent += "\n\nRelevant codebase context (from index):\n";
    for (const r of indexedFiles) {
      userContent += `\n--- ${r.path}${r.line ? ` (line ${r.line})` : ""} ---\n${r.preview}\n`;
    }
  }
  if (Object.keys(fileContents).length > 0) {
    userContent += "\n\nFile contents (path -> content):\n";
    for (const [path, content] of Object.entries(fileContents)) {
      userContent += `\n--- ${path} ---\n${content}\n`;
    }
  }

  const rules = await loadRules(supabase, workspaceId);
  const rulesPrompt = formatRulesForPrompt(rules);
  const systemPromptWithRules = COMPOSER_SYSTEM + rulesPrompt;

  const modelOpt = getModelForProvider(providerId, model);
  const cacheKey = hashForCache(
    "composer-plan",
    userContent.slice(0, 4000),
    rulesPrompt.slice(0, 500),
    String(providerId),
    String(modelOpt ?? "")
  );
  const { content: raw, usage } = await invokeChat({
    messages: [
      { role: "system", content: systemPromptWithRules },
      { role: "user", content: userContent },
    ],
    apiKey,
    providerId,
    model: modelOpt ?? undefined,
    task: "patch",
    userId,
    workspaceId,
    supabase,
    cacheKey,
  });

  const trimmed = raw.trim();
  let parseResult = parseJSONRobust<ComposerPlan>(trimmed, ["steps"]);
  if (!parseResult.success || !parseResult.data) {
    const normalized = trimmed.replace(/^[\s\S]*?(\{[\s\S]*)$/, "$1");
    if (normalized !== trimmed) parseResult = parseJSONRobust<ComposerPlan>(normalized, ["steps"]);
  }
  if (!parseResult.success || !parseResult.data) {
    throw new ComposerPlanError(
      `Failed to parse plan JSON. ${parseResult.error ?? "Unknown"}`,
      "invalid_plan"
    );
  }
  const plan = parseResult.data;

  if (!plan || !Array.isArray(plan.steps)) {
    throw new ComposerPlanError("LLM did not return a valid plan (missing steps array)", "invalid_plan");
  }

  const stepsByPath = new Map<string, FileEditStep>();
  for (const step of plan.steps) {
    if (step.type !== "file_edit" || typeof step.path !== "string" || typeof step.newContent !== "string") continue;
    const path = step.path.trim();
    if (!path || !candidatePaths.includes(path)) continue;
    stepsByPath.set(path, {
      type: "file_edit",
      path,
      newContent: step.newContent,
      oldContent: step.oldContent,
      description: step.description,
    });
  }
  let fileEditSteps = Array.from(stepsByPath.values());

  if (fileEditSteps.length === 0) {
    throw new ComposerPlanError("No valid file edit steps in plan. Ensure paths are in the candidate file list.", "invalid_plan");
  }

  if (scopeMode === "conservative" && fileEditSteps.length > 0) {
    fileEditSteps = applyScopeCaps(fileEditSteps, "conservative", undefined).steps as FileEditStep[];
  }

  const stepsWithContent = fileEditSteps.map((step) => ({
    path: step.path,
    originalContent: fileContents[step.path] ?? "",
    newContent: step.newContent,
    oldContent: step.oldContent,
    description: step.description,
  }));

  return {
    plan: { steps: fileEditSteps, summary: plan.summary },
    stepsWithContent,
    provider: providerId,
    usage,
  };
}

// --- Execute ---

function simpleHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

export type ExecuteComposerInput = {
  steps: FileEditStep[];
  workspaceId: string;
  userId: string;
  supabase: SupabaseClient;
  confirmedProtectedPaths?: string[];
  source?: "debug-from-log";
  debugFromLogMeta?: {
    errorLog?: string;
    errorType?: string;
    modelUsed?: string;
    providerId?: string;
  };
};

export type ExecuteComposerResult =
  | {
      success: true;
      filesEdited: string[];
      log: { path: string; status: "ok" | "error"; message: string }[];
      conflicts: { path: string; message: string }[];
      sandboxRunId?: string;
      sandboxChecks?: SandboxCheckResult;
      retried?: boolean;
      retryReason?: string;
      attempt1?: { testsPassed: boolean; logs: string };
      attempt2?: { testsPassed: boolean; logs: string };
    }
  | {
      success: false;
      filesEdited: string[];
      log: { path: string; status: "ok" | "error"; message: string }[];
      conflicts: { path: string; message: string }[];
      sandboxRunId?: string;
      sandboxChecks?: SandboxCheckResult;
      message?: string;
      retried?: boolean;
      retryReason?: string;
      attempt1?: { testsPassed: boolean; logs: string };
      attempt2?: { testsPassed: boolean; logs: string };
    };

export type ExecuteComposerNeedConfirmation = {
  needProtectedConfirmation: true;
  protectedPaths: string[];
};

/**
 * Execute composer steps via sandbox. Returns needProtectedConfirmation when protected paths require confirmation.
 */
export async function executeComposer(
  input: ExecuteComposerInput
): Promise<ExecuteComposerResult | ExecuteComposerNeedConfirmation> {
  const {
    steps,
    workspaceId,
    userId,
    supabase,
    confirmedProtectedPaths = [],
    source,
    debugFromLogMeta,
  } = input;

  const confirmedSet = new Set(confirmedProtectedPaths.map((p) => p.trim()).filter(Boolean));
  const isDebugFromLog = source === "debug-from-log";

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, safe_edit_mode")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    throw new ComposerPlanError("Workspace not found", "no_workspace");
  }

  const safeEditMode = workspace.safe_edit_mode !== false;
  const paths = steps.map((s) => s.path.trim());
  const protectedPaths = getProtectedPaths(paths);

  if (safeEditMode && protectedPaths.length > 0) {
    const allConfirmed = protectedPaths.every((p) => confirmedSet.has(p));
    if (!allConfirmed) {
      return { needProtectedConfirmation: true, protectedPaths };
    }
  }

  const filesEdited: string[] = [];
  const conflicts: { path: string; message: string }[] = [];
  const log: { path: string; status: "ok" | "error"; message: string }[] = [];

  if (steps.length === 0) {
    return { success: true, filesEdited, log, conflicts };
  }

  let sandboxRunId: string | null = null;
  let sandboxCheckResults: SandboxCheckResult | null = null;

  const sandboxMetadata: SandboxRunMetadata | undefined =
    isDebugFromLog && debugFromLogMeta
      ? {
          error_log: debugFromLogMeta.errorLog?.slice(0, 50000),
          error_type: debugFromLogMeta.errorType ?? undefined,
          model_used: debugFromLogMeta.modelUsed ?? undefined,
          proposed_edit_paths: steps.map((s) => s.path.trim()),
          first_error_at: new Date().toISOString(),
          error_fingerprint: debugFromLogMeta.errorLog
            ? simpleHash(debugFromLogMeta.errorLog.slice(0, 500).replace(/\s+/g, " "))
            : undefined,
        }
      : undefined;

  try {
    sandboxRunId = await createSandboxFromWorkspace(supabase, workspaceId, userId, {
      source: isDebugFromLog ? "debug-from-log" : "composer",
      metadata: sandboxMetadata,
    });

    const sandboxResult = await applyEditsToSandbox(supabase, sandboxRunId, steps);

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
    const hasFailures =
      sandboxCheckResults.lint.status === "failed" ||
      sandboxCheckResults.tests.status === "failed" ||
      sandboxCheckResults.run.status === "failed";
    const sandboxChecksPassed = !hasFailures;

    if (isDebugFromLog && debugFromLogMeta?.modelUsed) {
      const editSizeDelta = steps.reduce(
        (acc, s) => acc + Math.abs((s.newContent?.length ?? 0) - (s.oldContent?.length ?? 0)),
        0
      );
      recordModelOutcome(supabase, {
        userId,
        taskType: "patch",
        modelId: debugFromLogMeta.modelUsed,
        providerId: debugFromLogMeta.providerId ?? "openrouter",
        outcome: sandboxChecksPassed ? "win" : "loss",
        editSizeDelta,
        sandboxChecksPassed,
      }).catch(() => {});
    }

    if (sandboxChecksPassed) {
      const promoteResult = await promoteSandboxToWorkspace(supabase, sandboxRunId);
      filesEdited.push(...promoteResult.filesEdited);
      conflicts.push(...promoteResult.conflicts);
      return {
        success: true,
        filesEdited,
        log,
        conflicts,
        sandboxRunId,
        sandboxChecks: sandboxCheckResults,
      };
    }

    // Retry for debug-from-log
    const attempt1Logs = [
      sandboxCheckResults.lint.status === "failed" ? `Lint: ${sandboxCheckResults.lint.logs}` : "",
      sandboxCheckResults.tests.status === "failed" ? `Tests: ${sandboxCheckResults.tests.logs}` : "",
      sandboxCheckResults.run.status === "failed" ? `Run: ${sandboxCheckResults.run.logs}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (isDebugFromLog && debugFromLogMeta?.errorLog && attempt1Logs) {
      try {
        const failureSummary = `Sandbox checks failed after first fix attempt:\n${attempt1Logs}`;
        const retryResult = await runDebugFromLog(supabase, workspaceId, userId, debugFromLogMeta.errorLog, {
          scopeMode: "conservative",
          sandboxFailureSummary: failureSummary,
        });
        const retrySteps: FileEditStep[] = (retryResult.edits ?? []).map((e) => ({
          type: "file_edit" as const,
          path: e.path,
          oldContent: e.oldContent,
          newContent: e.newContent,
          description: e.description,
          source: "debug-from-log" as const,
        }));
        if (retrySteps.length > 0) {
          const sandboxRunId2 = await createSandboxFromWorkspace(supabase, workspaceId, userId, {
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
          const hasFailures2 =
            sandboxCheckResults2.lint.status === "failed" ||
            sandboxCheckResults2.tests.status === "failed" ||
            sandboxCheckResults2.run.status === "failed";
          if (!hasFailures2) {
            const promoteResult2 = await promoteSandboxToWorkspace(supabase, sandboxRunId2);
            return {
              success: true,
              filesEdited: promoteResult2.filesEdited,
              log,
              conflicts: promoteResult2.conflicts,
              sandboxRunId: sandboxRunId2,
              sandboxChecks: sandboxCheckResults2,
              retried: true,
              retryReason: "sandbox_tests_failed",
              attempt1: { testsPassed: false, logs: attempt1Logs },
              attempt2: { testsPassed: true, logs: "" },
            };
          }
          return {
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
            attempt2: {
              testsPassed: false,
              logs: [sandboxCheckResults2.lint.logs, sandboxCheckResults2.tests.logs, sandboxCheckResults2.run.logs].filter(Boolean).join("\n"),
            },
            message: "I tried twice and tests still fail. Please review the diffs and logs manually.",
          };
        }
      } catch (retryErr) {
        console.error("Debug-from-log retry failed:", retryErr);
      }
    }

    if (sandboxCheckResults.run.status === "failed") {
      conflicts.push({
        path: "",
        message: `Application failed to run. Changes were not applied. ${sandboxCheckResults.run.logs}`,
      });
    }
    if (sandboxCheckResults.lint.status === "failed") {
      conflicts.push({ path: "", message: `Lint failed: ${sandboxCheckResults.lint.logs}` });
    }
    if (sandboxCheckResults.tests.status === "failed") {
      conflicts.push({ path: "", message: `Tests failed: ${sandboxCheckResults.tests.logs}` });
    }
    return {
      success: false,
      filesEdited: [],
      log,
      conflicts,
      sandboxRunId,
      sandboxChecks: sandboxCheckResults,
      message: "Sandbox checks failed. Fix errors before applying changes.",
    };
  } catch (sandboxError) {
    const errorMsg = sandboxError instanceof Error ? sandboxError.message : "Sandbox processing failed";
    log.push({ path: "", status: "error", message: `Sandbox error: ${errorMsg}` });
  }

  return {
    success: false,
    filesEdited,
    log,
    conflicts,
    sandboxRunId: sandboxRunId ?? undefined,
    sandboxChecks: sandboxCheckResults ?? undefined,
  };
}
