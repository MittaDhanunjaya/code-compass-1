/**
 * Shared debug-from-log analysis: used by POST /api/workspaces/[id]/debug-from-log
 * and by POST /api/ci/propose-fixes. Returns suspected root cause, explanation, and edits.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import { getModelForProvider, PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import { applyEnvRouting } from "@/lib/llm/task-routing";
import { getPatchModelCandidates } from "@/lib/llm/ab-stats";
import { invokeChatWithFallback, type InvokeChatCandidate } from "@/lib/llm/router";
import { validateDebugFromLogOutput } from "@/lib/validation";
import { detectStackFromPaths } from "@/lib/sandbox/stack-commands";
import { getDebugPromptHintsForStack } from "@/lib/sandbox/stack-profiles";

const MAX_FILES_FOR_DEBUG = 25;
const SNIPPET_PADDING = 40;
const MAX_SNIPPET_CHARS = 6000;

export type DebugFromLogEdit = {
  path: string;
  description?: string;
  oldContent?: string;
  newContent: string;
};

export type DebugFromLogResult = {
  suspectedRootCause: string | null;
  explanation: string | null;
  verificationCommand: string | null;
  edits: DebugFromLogEdit[];
};

/** Exported for tests. */
export function normalizeStackLog(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const trimmed = lines.map((l) => l.replace(/^\s*(at\s+|#\d+\s+)/, "").trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of trimmed) {
    const key = line.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join("\n");
}

/** Exported for tests. */
export function preprocessLog(logText: string): {
  errorType: string | null;
  topFrame: { file: string; line?: number } | null;
  routeOrCommand: string | null;
  normalizedLog: string;
} {
  const normalizedLog = normalizeStackLog(logText);
  let errorType: string | null = null;
  const errorTypeRe = /(?:^|\n)(?:Uncaught\s+)?(TypeError|ReferenceError|SyntaxError|RangeError|Error|EvalError|URIError|AssertionError|ImportError|ModuleNotFoundError|AttributeError|NameError|KeyError|ValueError|[\w.]+Error|Error:)\s*[:(\s]/im;
  const et = logText.match(errorTypeRe);
  if (et) {
    errorType = (et[1] ?? null)?.endsWith(":") ? et[1]!.slice(0, -1) : et[1] ?? null;
  }
  let topFrame: { file: string; line?: number } | null = null;
  const atFileRe = /at\s+(?:\S+\s+\()?([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|py))(?:\s*:\s*(\d+))?/i;
  const pathLineRe = /(?:File\s+["']([^"']+)["']|([\w./-]+\.(?:ts|tsx|js|jsx|py)))\s*(?::\s*(\d+))?/i;
  const firstAt = logText.match(atFileRe);
  const firstPath = logText.match(pathLineRe);
  if (firstAt) {
    topFrame = { file: firstAt[1]!.replace(/\\/g, "/"), line: firstAt[2] ? parseInt(firstAt[2], 10) : undefined };
  } else if (firstPath) {
    topFrame = { file: (firstPath[1] || firstPath[2] || "").replace(/\\/g, "/"), line: firstPath[3] ? parseInt(firstPath[3], 10) : undefined };
  }
  let routeOrCommand: string | null = null;
  const route = logText.match(/(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s]+)/i);
  const cmd = logText.match(/(npm\s+run\s+\w+|node\s+[\w./-]+|yarn\s+\w+)/i);
  if (route) routeOrCommand = `${route[1]} ${route[2]}`;
  else if (cmd) routeOrCommand = cmd[1];
  return { errorType, topFrame, routeOrCommand, normalizedLog };
}

/** Exported for tests. */
export function extractPathsAndLines(logText: string): { path: string; line?: number }[] {
  const seen = new Map<string, number>();
  const results: { path: string; line?: number }[] = [];
  const relativePathRe = /(?:File\s+["']|at\s+|\/\s+|in\s+)((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|py|jsx?|mts|cjs))\s*(?::\s*(\d+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = relativePathRe.exec(logText)) !== null) {
    const path = m[1]!.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    const line = m[2] ? parseInt(m[2], 10) : undefined;
    if (path && !seen.has(path)) {
      seen.set(path, line ?? 0);
      results.push({ path, line });
    }
  }
  const pythonRe = /File\s+["']([^"']+)["']\s*,\s*line\s+(\d+)/gi;
  while ((m = pythonRe.exec(logText)) !== null) {
    let path = m[1]!.replace(/\\/g, "/").trim();
    const line = parseInt(m[2]!, 10);
    const match = path.match(/(?:^|\/)(?:src|app|pages|lib|components|api)\/[\s\S]*/);
    if (match) path = match[0].replace(/^\//, "");
    if (path && !seen.has(path)) {
      seen.set(path, line);
      results.push({ path, line });
    }
  }
  const atPathRe = /\b(at\s+)?([\w./-]+\.(?:ts|tsx|js|jsx|mjs|py))\s*:\s*(\d+)(?:\s*:\s*(\d+))?/gi;
  while ((m = atPathRe.exec(logText)) !== null) {
    let path = m[2]!.replace(/\\/g, "/").replace(/^\//, "");
    const line = parseInt(m[3]!, 10);
    const match = path.match(/(?:^|\/)(?:src|app|pages|lib|components|api)\/[\s\S]*/);
    if (match) path = match[0].replace(/^\//, "");
    if (path && !seen.has(path)) {
      seen.set(path, line);
      results.push({ path, line });
    }
  }
  return results;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\//, "").trim();
}

function getSnippet(content: string, aroundLine: number, padding: number, maxChars?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, aroundLine - 1 - padding);
  const end = Math.min(lines.length, aroundLine + padding);
  let snippet = lines.slice(start, end).join("\n");
  if (maxChars != null && snippet.length > maxChars) snippet = snippet.slice(0, maxChars) + "\n...";
  return snippet;
}

function getImportTargets(content: string, pathSet: Set<string>): string[] {
  const targets: string[] = [];
  const re = /(?:from\s+["']([^"']+)["']|import\s+[\w*{}\s,]+\s+from\s+["']([^"']+)["'])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const spec = (m[1] || m[2] || "").trim();
    if (!spec) continue;
    const normalized = spec.replace(/^\.\//, "").replace(/^\//, "");
    if (pathSet.has(normalized)) {
      targets.push(normalized);
      continue;
    }
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      const withExt = normalized.endsWith(ext) ? normalized : `${normalized}${ext}`;
      if (pathSet.has(withExt)) {
        targets.push(withExt);
        break;
      }
    }
  }
  return [...new Set(targets)];
}

const DEBUG_SYSTEM = `You are an expert debugger and code fixer, similar to Cursor's error analysis. Your job is to deeply understand runtime errors and provide working fixes.

**Your Process:**
1. **Analyze the error thoroughly**: Read the full stack trace, understand the error type, identify where it occurs, and trace through the call stack to understand the execution flow.
2. **Understand the codebase context**: Look at the implicated files, understand what the code is trying to do, check imports and dependencies, understand the data flow.
3. **Identify the root cause**: Don't just fix symptoms - find WHY the error is happening. Is it a missing import? Wrong variable name? Type mismatch? Undefined value? Missing dependency? Logic error?
4. **Propose a complete fix**: Provide edits that fix the root cause, not just the immediate error.

**Critical Requirements:**
- For each edit, you MUST provide \`oldContent\` with the EXACT code snippet that exists in the file (including surrounding context lines).
- Provide minimal, surgical changes - only modify what's necessary to fix the error.
- Do NOT refactor unrelated code, change formatting, or add unnecessary changes.
- If you need to add imports, include them in the edit.
- Order edits by dependency (e.g., fix imports before using them).

**Response Format:**
You MUST respond with ONLY a JSON object, no markdown, no code blocks:

{
  "suspectedRootCause": "One clear sentence explaining the root cause",
  "explanation": "Brief explanation of what you found and what changes you made to fix it",
  "verificationCommand": "Exact shell command to verify the fix (e.g. npm test, npm run dev, pytest)",
  "edits": [
    {
      "path": "exact file path from workspace (must match exactly)",
      "description": "What this edit fixes",
      "oldContent": "EXACT code snippet from the file that will be replaced (required for existing files)",
      "newContent": "The replacement code (for existing files) or full file content (for new files)"
    }
  ]
}

**Rules:**
- "verificationCommand" must be a concrete command the user can run to verify the fix (e.g. npm test, npm run dev, pytest tests/).
- "path" must exactly match one of the workspace file paths provided.
- For existing files: ALWAYS include "oldContent" with the exact code that exists.
- For new files: omit "oldContent"; "newContent" is the full file.
- If the error cannot be fixed by editing workspace files, return "edits": [] and explain why in "explanation".
- Tailor your analysis and fixes to this specific error and codebase; avoid generic or one-size-fits-all suggestions.
- Output ONLY the JSON object, no markdown formatting.`;

async function getApiKey(
  supabase: SupabaseClient,
  userId: string,
  provider: ProviderId
): Promise<string | null> {
  const { data } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", userId)
    .eq("provider", provider)
    .single();
  if (!data?.key_encrypted) return null;
  try {
    return decrypt(data.key_encrypted);
  } catch {
    return null;
  }
}

export type RunDebugFromLogOptions = {
  scopeMode?: "conservative" | "normal" | "aggressive";
  /** When present, appended to log and prompts a minimal retry fix. */
  sandboxFailureSummary?: string;
};

/**
 * Run debug-from-log analysis: load workspace files, call LLM, return structured result.
 * Used by POST /api/workspaces/[id]/debug-from-log and POST /api/ci/propose-fixes.
 * @param userId - Used for API key lookup (e.g. workspace owner_id for CI).
 */
export async function runDebugFromLog(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  logText: string,
  options?: RunDebugFromLogOptions
): Promise<DebugFromLogResult> {
  const effectiveLog = options?.sandboxFailureSummary
    ? `${logText}\n\n--- Sandbox failure (retry with minimal fix) ---\n${options.sandboxFailureSummary}`
    : logText;
  const isRetry = !!options?.sandboxFailureSummary;
  const scopeHint = options?.scopeMode === "conservative" || isRetry
    ? "\n\n**This is a retry. Focus only on the minimal set of files and lines needed to fix the failing tests. Prefer small, surgical edits.**"
    : "";
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, github_current_branch, github_repo")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return {
      suspectedRootCause: null,
      explanation: "Workspace not found.",
      verificationCommand: null,
      edits: [],
    };
  }

  const workspaceName = (workspace as { name?: string }).name ?? "Workspace";
  const currentBranch = (workspace as { github_current_branch?: string }).github_current_branch ?? "main";
  const repo = (workspace as { github_repo?: string }).github_repo ?? null;

  const { data: fileRows } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .order("path", { ascending: true })
    .limit(MAX_FILES_FOR_DEBUG);

  const files = (fileRows ?? []).map((r) => ({
    path: r.path,
    content: (r.content ?? "") as string,
  }));
  const pathSet = new Set(files.map((f) => f.path));

  const extracted = extractPathsAndLines(effectiveLog);
  const implicatedPaths = new Set<string>();
  for (const { path } of extracted) {
    const norm = normalizePath(path);
    if (pathSet.has(norm)) implicatedPaths.add(norm);
    else {
      const basename = norm.split("/").pop() ?? norm;
      const match = files.find((f) => f.path.endsWith(basename) || f.path === norm);
      if (match) implicatedPaths.add(match.path);
    }
  }
  const lineByPath = new Map<string, number>();
  for (const { path, line } of extracted) {
    if (line == null) continue;
    const norm = normalizePath(path);
    if (pathSet.has(norm)) {
      if (!lineByPath.has(norm) || (lineByPath.get(norm) ?? 0) > line) lineByPath.set(norm, line);
    } else {
      const basename = norm.split("/").pop() ?? norm;
      const match = files.find((f) => f.path.endsWith(basename));
      if (match && !lineByPath.has(match.path)) lineByPath.set(match.path, line);
    }
  }

  const debugMeta = preprocessLog(effectiveLog);
  const implicatedFiles = files.filter((f) => implicatedPaths.has(f.path));
  const relatedPaths = new Set<string>();
  for (const f of implicatedFiles) {
    for (const t of getImportTargets(f.content, pathSet)) {
      if (!implicatedPaths.has(t)) relatedPaths.add(t);
    }
  }
  const relatedFiles = files.filter((f) => relatedPaths.has(f.path)).slice(0, 5);
  const isLikelyFrontend = Array.from(implicatedPaths).some((p) => /^(app|pages|src\/app|src\/pages|components)/.test(p));
  const isLikelyBackend = Array.from(implicatedPaths).some((p) => /^(api|app\/api|src\/api|lib|server)/.test(p));
  let contextHint = "Workspace files and error log.";
  if (isLikelyFrontend && !isLikelyBackend) contextHint = "Likely frontend (app/pages/components).";
  else if (isLikelyBackend && !isLikelyFrontend) contextHint = "Likely backend (api/lib).";

  const snippetParts: string[] = [];
  for (const f of implicatedFiles) {
    const line = lineByPath.get(f.path);
    if (line != null) {
      snippetParts.push(`## ${f.path} (ERROR OCCURS HERE - line ${line})\n\`\`\`\n${getSnippet(f.content, line, SNIPPET_PADDING, MAX_SNIPPET_CHARS)}\n\`\`\``);
    } else {
      snippetParts.push(`## ${f.path} (ERROR FILE)\n\`\`\`\n${f.content.length < 5000 ? f.content : f.content.slice(0, MAX_SNIPPET_CHARS)}\n\`\`\``);
    }
  }
  for (const f of relatedFiles) {
    const line = lineByPath.get(f.path);
    const snippet = line != null ? getSnippet(f.content, line, SNIPPET_PADDING, MAX_SNIPPET_CHARS) : f.content.length < 5000 ? f.content : f.content.slice(0, MAX_SNIPPET_CHARS);
    snippetParts.push(`## ${f.path} (RELATED)\n\`\`\`\n${snippet}\n\`\`\``);
  }
  const configFiles = files.filter((f) => /^(package\.json|tsconfig\.json|next\.config|\.env|config\.|settings\.)/i.test(f.path.split("/").pop() || ""));
  for (const f of configFiles.slice(0, 2)) {
    snippetParts.push(`## ${f.path} (CONFIGURATION)\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``);
  }
  const otherFiles = files.filter((f) => !implicatedPaths.has(f.path) && !relatedPaths.has(f.path) && !configFiles.some((cf) => cf.path === f.path));
  if (otherFiles.length > 0 && snippetParts.length < 10) {
    for (const f of otherFiles.slice(0, 3)) {
      snippetParts.push(`## ${f.path} (ADDITIONAL CONTEXT)\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``);
    }
  }
  const fileContext = snippetParts.join("\n\n");
  const metaBlob = [
    `errorType: ${debugMeta.errorType ?? "unknown"}`,
    debugMeta.topFrame ? `topFrame: ${debugMeta.topFrame.file}${debugMeta.topFrame.line != null ? `:${debugMeta.topFrame.line}` : ""}` : "",
    debugMeta.routeOrCommand ? `routeOrCommand: ${debugMeta.routeOrCommand}` : "",
  ].filter(Boolean).join(", ");

  const workspacePaths = files.map((f) => f.path);
  const stack = detectStackFromPaths(workspacePaths);
  const stackHints = getDebugPromptHintsForStack(stack);

  const noPathsInLog = implicatedPaths.size === 0;
  const contextNote = noPathsInLog
    ? "\n**Note:** No file paths were found in the error log. Base your analysis on the full raw error text and the workspace files above. Give a fix specific to THIS project and this exact error—not generic advice.\n"
    : "";

  const userMessage = `${stackHints}**RUNTIME ERROR ANALYSIS REQUEST**
${contextNote}

**Error Metadata:**
${metaBlob}

**Normalized Stack Trace:**
\`\`\`
${debugMeta.normalizedLog}
\`\`\`

**Full Raw Error Log:**
\`\`\`
${effectiveLog}
\`\`\`
${scopeHint}

**Workspace Context:**
- Name: ${workspaceName}
- Branch: ${currentBranch}${repo ? `\n- Repo: ${repo}` : ""}
- Context: ${contextHint}

**Available Workspace Files (use exact paths):**
${files.map((f) => `- ${f.path}`).join("\n")}

**Relevant File Contents:**

${fileContext}

**Your Task:**
1. Analyze the error thoroughly - understand what's happening, where it fails, and why.
2. Trace through the code to identify the root cause.
3. Propose fixes that address the root cause. Use EXACT file paths from the list above. Include "oldContent" for existing files.
4. Tailor your answer to this specific error and codebase; avoid generic or repeated suggestions. Output ONLY the JSON object, no markdown.`;

  applyEnvRouting();

  const patchCandidates = await getPatchModelCandidates(supabase, userId, "debug");
  const candidates: InvokeChatCandidate[] = [];
  for (const c of patchCandidates) {
    const key = await getApiKey(supabase, userId, c.providerId as ProviderId);
    if (c.providerId === "ollama" || c.providerId === "lmstudio" || key) {
      candidates.push({
        providerId: c.providerId as ProviderId,
        model: c.modelId,
        apiKey: key ?? "",
      });
    }
  }

  if (candidates.length === 0) {
    const providersToTry = [...PROVIDERS];
    for (const p of providersToTry) {
      const key = await getApiKey(supabase, userId, p as ProviderId);
      if (key) {
        candidates.push({
          providerId: p as ProviderId,
          model: getModelForProvider(p as ProviderId) ?? undefined,
          apiKey: key,
        });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    return {
      suspectedRootCause: null,
      explanation: "No API key configured for any provider. Add one in API Key settings.",
      verificationCommand: null,
      edits: [],
    };
  }

  try {
    const { content } = await invokeChatWithFallback({
      messages: [
        { role: "system", content: DEBUG_SYSTEM },
        { role: "user", content: userMessage },
      ],
      task: "debug",
      temperature: 0.35,
      candidates,
      userId,
      workspaceId,
      supabase,
    });

    const trimmed = (content ?? "").trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0]! : trimmed;

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        suspectedRootCause: null,
        explanation: "Could not parse model response as JSON.",
        verificationCommand: null,
        edits: [],
      };
    }

    const validated = validateDebugFromLogOutput(parsed);
    const suspectedRootCause = validated.suspectedRootCause;
    const explanation = validated.explanation;
    const verificationCommand = validated.verificationCommand;
    const rawEdits = validated.edits;
    const edits: DebugFromLogEdit[] = [];
    for (const e of rawEdits) {
      const path = typeof e.path === "string" ? e.path.trim() : "";
      const newContent = typeof e.newContent === "string" ? e.newContent.trim() : "";
      if (!path || !newContent) continue;
      const pathExists = pathSet.has(path);
      if (!pathExists && e.oldContent) continue;
      edits.push({
        path,
        description: typeof e.description === "string" ? e.description.trim() : undefined,
        oldContent: typeof e.oldContent === "string" && e.oldContent.trim() ? e.oldContent.trim() : undefined,
        newContent,
      });
    }

    return {
      suspectedRootCause: suspectedRootCause ?? null,
      explanation: explanation ?? "Analysis complete.",
      verificationCommand: verificationCommand ?? null,
      edits,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "LLM request failed";
    return {
      suspectedRootCause: null,
      explanation: `Debug failed: ${msg}`,
      verificationCommand: null,
      edits: [],
    };
  }
}
