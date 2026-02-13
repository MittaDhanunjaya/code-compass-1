import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { decrypt } from "@/lib/encrypt";
import { getModelForProvider, PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import { applyEnvRouting } from "@/lib/llm/task-routing";
import { getPatchModelCandidates } from "@/lib/llm/ab-stats";
import { invokeChatWithFallback, type InvokeChatCandidate } from "@/lib/llm/router";
import { createAgentEvent } from "@/lib/agent-events";
import { getDevBypassUser } from "@/lib/auth-dev-bypass";
import { validateDebugFromLogOutput } from "@/lib/validation";
import { detectStackFromPaths } from "@/lib/sandbox/stack-commands";
import { getDebugPromptHintsForStack } from "@/lib/sandbox/stack-profiles";

const MAX_FILES_FOR_DEBUG = 25;
const SNIPPET_PADDING = 40;
const MAX_SNIPPET_CHARS = 6000;

export type DebugMeta = {
  errorType: string | null;
  topFrame: { file: string; line?: number } | null;
  routeOrCommand: string | null;
  normalizedLog: string;
};

/** Normalize stack trace: trim noisy prefixes, collapse duplicate consecutive frames. */
function normalizeStackLog(raw: string): string {
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

/** Extract errorType, topFrame, routeOrCommand from log text. */
function preprocessLog(logText: string): DebugMeta {
  const normalizedLog = normalizeStackLog(logText);
  let errorType: string | null = null;
  // More comprehensive error type matching
  const errorTypeRe = /(?:^|\n)(?:Uncaught\s+)?(TypeError|ReferenceError|SyntaxError|RangeError|Error|EvalError|URIError|AssertionError|ImportError|ModuleNotFoundError|AttributeError|NameError|KeyError|ValueError|[\w.]+Error|Error:)\s*[:(\s]/im;
  const et = logText.match(errorTypeRe);
  if (et) {
    errorType = et[1] ?? null;
    // Clean up common patterns
    if (errorType?.endsWith(":")) {
      errorType = errorType.slice(0, -1);
    }
  }

  let topFrame: { file: string; line?: number } | null = null;
  const atFileRe = /at\s+(?:\S+\s+\()?([\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|py))(?:\s*:\s*(\d+))?/i;
  const pathLineRe = /(?:File\s+["']([^"']+)["']|([\w./-]+\.(?:ts|tsx|js|jsx|py)))\s*(?::\s*(\d+))?/i;
  const firstAt = logText.match(atFileRe);
  const firstPath = logText.match(pathLineRe);
  if (firstAt) {
    topFrame = {
      file: firstAt[1]!.replace(/\\/g, "/"),
      line: firstAt[2] ? parseInt(firstAt[2], 10) : undefined,
    };
  } else if (firstPath) {
    topFrame = {
      file: (firstPath[1] || firstPath[2] || "").replace(/\\/g, "/"),
      line: firstPath[3] ? parseInt(firstPath[3], 10) : undefined,
    };
  }

  let routeOrCommand: string | null = null;
  const routeRe = /(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s]+)/i;
  const cmdRe = /(npm\s+run\s+\w+|node\s+[\w./-]+|yarn\s+\w+)/i;
  const route = logText.match(routeRe);
  const cmd = logText.match(cmdRe);
  if (route) routeOrCommand = `${route[1]} ${route[2]}`;
  else if (cmd) routeOrCommand = cmd[1];

  return { errorType, topFrame, routeOrCommand, normalizedLog };
}

/** Extract candidate file paths and line numbers from log text. */
function extractPathsAndLines(logText: string): { path: string; line?: number }[] {
  const seen = new Map<string, number>();
  const results: { path: string; line?: number }[] = [];

  // Relative repo paths: src/app/page.tsx, pages/index.tsx, lib/foo.ts, app/api/route.ts
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

  // File "path", line N (Python style)
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

  // at path:line:col or path:line
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

/** Normalize path to match workspace file paths (strip leading slash, normalize separators). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\//, "").trim();
}

/** Get snippet around a line (1-based), capped in size. */
function getSnippet(content: string, aroundLine: number, padding: number, maxChars?: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, aroundLine - 1 - padding);
  const end = Math.min(lines.length, aroundLine + padding);
  let snippet = lines.slice(start, end).join("\n");
  if (maxChars != null && snippet.length > maxChars) {
    snippet = snippet.slice(0, maxChars) + "\n...";
  }
  return snippet;
}

/** Collect import targets that exist in pathSet from file content. */
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
4. **Propose a complete fix**: Provide edits that fix the root cause, not just the immediate error. Consider:
   - Missing imports or dependencies
   - Undefined variables or functions
   - Type mismatches
   - Logic errors
   - Missing error handling
   - Incorrect API usage
   - Missing configuration
   - Environment-specific issues

**Critical Requirements:**
- For each edit, you MUST provide \`oldContent\` with the EXACT code snippet that exists in the file (including surrounding context lines). This allows the tool to apply changes even if the user made minor edits.
- Provide minimal, surgical changes - only modify what's necessary to fix the error.
- Do NOT refactor unrelated code, change formatting, or add unnecessary changes.
- If you need to add imports, include them in the edit.
- If you need to fix multiple related issues, include all necessary edits.
- Order edits by dependency (e.g., fix imports before using them).

**Response Format:**
You MUST respond with ONLY a JSON object, no markdown, no code blocks, no explanations outside JSON:

{
  "suspectedRootCause": "One clear sentence explaining the root cause (e.g., 'Missing import for useState hook in React component' or 'Variable 'user' is undefined because it's not awaited from async function')",
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
- "path" must exactly match one of the workspace file paths provided.
- For existing files: ALWAYS include "oldContent" with the exact code that exists (use surrounding lines for context matching).
- For new files: omit "oldContent"; "newContent" is the full file.
- If the error cannot be fixed by editing workspace files, return "edits": [] and explain why in "explanation".
- Be thorough - if the error requires multiple related fixes (e.g., fixing imports AND the code that uses them), include all edits.
- Think step by step: understand the error → identify root cause → propose complete fix → verify the fix addresses the root cause.`;

type RouteParams = { params: Promise<{ id: string }> };

async function getApiKey(
  supabase: Awaited<ReturnType<typeof createClient>>,
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

export type DebugFromLogEdit = {
  path: string;
  description?: string;
  oldContent?: string;
  newContent: string;
};

export type DebugFromLogResponse = {
  suspectedRootCause: string | null;
  explanation: string | null;
  verificationCommand: string | null;
  edits: DebugFromLogEdit[];
  /** Optional events for the frontend to show in Activity Feed / run summary. */
  events?: Array<{ type: string; message: string; meta?: Record<string, unknown> }>;
};

export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
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

  let body: { logText?: string; provider?: string; model?: string; scopeMode?: "conservative" | "normal" | "aggressive" };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const logText = typeof body.logText === "string" ? body.logText.trim() : "";
  const scopeMode = body.scopeMode === "conservative" || body.scopeMode === "aggressive" ? body.scopeMode : "normal";
  if (!logText) {
    return NextResponse.json(
      { error: "logText is required" },
      { status: 400 }
    );
  }
  const fileLimit = scopeMode === "conservative" ? 5 : scopeMode === "aggressive" ? 40 : MAX_FILES_FOR_DEBUG;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, github_current_branch, github_repo")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const workspaceName = (workspace as { name?: string }).name ?? "Workspace";
  const currentBranch = (workspace as { github_current_branch?: string }).github_current_branch ?? "main";
  const repo = (workspace as { github_repo?: string }).github_repo ?? null;

  const { data: fileRows } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .order("path", { ascending: true })
    .limit(fileLimit);

  const files = (fileRows ?? []).map((r) => ({
    path: r.path,
    content: (r.content ?? "") as string,
  }));
  const pathSet = new Set(files.map((f) => f.path));

  const extracted = extractPathsAndLines(logText);
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

  const debugMeta = preprocessLog(logText);

  const implicatedFiles = files.filter((f) => implicatedPaths.has(f.path));
  const relatedPaths = new Set<string>();
  for (const f of implicatedFiles) {
    for (const t of getImportTargets(f.content, pathSet)) {
      if (!implicatedPaths.has(t)) relatedPaths.add(t);
    }
  }
  const relatedFiles = files.filter((f) => relatedPaths.has(f.path)).slice(0, 5);
  const isLikelyFrontend = Array.from(implicatedPaths).some(
    (p) => /^(app|pages|src\/app|src\/pages|components)/.test(p)
  );
  const isLikelyBackend = Array.from(implicatedPaths).some(
    (p) => /^(api|app\/api|src\/api|lib|server)/.test(p)
  );
  let contextHint = "Workspace files and error log.";
  if (isLikelyFrontend && !isLikelyBackend) contextHint = "Likely frontend (app/pages/components).";
  else if (isLikelyBackend && !isLikelyFrontend) contextHint = "Likely backend (api/lib).";

  const snippetParts: string[] = [];
  
  // Prioritize files mentioned in error stack trace
  for (const f of implicatedFiles) {
    const line = lineByPath.get(f.path);
    if (line != null) {
      const snippet = getSnippet(f.content, line, SNIPPET_PADDING, MAX_SNIPPET_CHARS);
      snippetParts.push(`## ${f.path} (ERROR OCCURS HERE - line ${line})\n\`\`\`\n${snippet}\n\`\`\``);
    } else {
      // Show full file if small, or first part if large
      if (f.content.length < 5000) {
        snippetParts.push(`## ${f.path} (ERROR FILE)\n\`\`\`\n${f.content}\n\`\`\``);
      } else {
        snippetParts.push(`## ${f.path} (ERROR FILE - showing first part)\n\`\`\`\n${f.content.slice(0, MAX_SNIPPET_CHARS)}\n\`\`\``);
      }
    }
  }
  
  // Include related files (imports, dependencies)
  for (const f of relatedFiles) {
    const line = lineByPath.get(f.path);
    const snippet = line != null
      ? getSnippet(f.content, line, SNIPPET_PADDING, MAX_SNIPPET_CHARS)
      : f.content.length < 5000 ? f.content : f.content.slice(0, MAX_SNIPPET_CHARS);
    snippetParts.push(`## ${f.path} (RELATED - imported/used by error file)\n\`\`\`\n${snippet}\n\`\`\``);
  }
  
  // Include key configuration files if they exist
  const configFiles = files.filter((f) => 
    /^(package\.json|tsconfig\.json|next\.config|\.env|config\.|settings\.)/i.test(f.path.split("/").pop() || "")
  );
  for (const f of configFiles.slice(0, 2)) {
    snippetParts.push(`## ${f.path} (CONFIGURATION)\n\`\`\`\n${f.content.slice(0, 2000)}\n\`\`\``);
  }
  
  // Include a few other files for context if we have room
  const otherFiles = files.filter((f) => 
    !implicatedPaths.has(f.path) && 
    !relatedPaths.has(f.path) &&
    !configFiles.some(cf => cf.path === f.path)
  );
  if (otherFiles.length > 0 && snippetParts.length < 10) {
    for (const f of otherFiles.slice(0, 3)) {
      snippetParts.push(`## ${f.path} (ADDITIONAL CONTEXT)\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``);
    }
  }
  
  const fileContext = snippetParts.join("\n\n");

  const metaBlob = [
    `errorType: ${debugMeta.errorType ?? "unknown"}`,
    debugMeta.topFrame
      ? `topFrame: ${debugMeta.topFrame.file}${debugMeta.topFrame.line != null ? `:${debugMeta.topFrame.line}` : ""}`
      : "",
    debugMeta.routeOrCommand ? `routeOrCommand: ${debugMeta.routeOrCommand}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const workspacePaths = files.map((f) => f.path);
  const stack = detectStackFromPaths(workspacePaths);
  const stackHints = getDebugPromptHintsForStack(stack);

  const { classifyErrorLog, getClassificationHint } = await import("@/lib/agent/error-classifier");
  const errorClassification = classifyErrorLog(logText);
  const classificationHint = getClassificationHint(errorClassification);
  const env = { os: process.platform, nodeVersion: process.version, framework: stack ?? "unknown" };

  const userMessage = `${stackHints}**RUNTIME ERROR ANALYSIS REQUEST**

**Error Classification:** ${errorClassification}
**Hint:** ${classificationHint}

**Environment:** ${JSON.stringify(env)}

**Error Metadata:**
${metaBlob}

**Normalized Stack Trace:**
\`\`\`
${debugMeta.normalizedLog}
\`\`\`

**Full Raw Error Log:**
\`\`\`
${logText}
\`\`\`

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
3. Propose MINIMAL fixes that address the root cause (surgical edits only).
4. Explain the root cause in your analysis.
5. For each edit, provide the EXACT "oldContent" snippet from the file so the tool can match and replace it accurately.

**Important:** 
- Use EXACT file paths from the list above.
- Include surrounding context lines in "oldContent" for reliable matching.
- Fix the root cause completely - don't leave related issues unfixed.
- Output ONLY the JSON object, no markdown formatting.`;

  applyEnvRouting();

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const useTaskRouting = !body.provider && !body.model;
  let candidates: InvokeChatCandidate[];

  if (useTaskRouting) {
    const patchCandidates = await getPatchModelCandidates(supabase, user.id, "debug");
    candidates = [];
    for (const c of patchCandidates) {
      const key = await getApiKey(supabase, user.id, c.providerId as ProviderId);
      if (c.providerId === "ollama" || c.providerId === "lmstudio" || key) {
        candidates.push({
          providerId: c.providerId as ProviderId,
          model: c.modelId,
          apiKey: key ?? "",
        });
      }
    }
  } else {
    const providersToTry = PROVIDERS.includes(requestedProvider)
      ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
      : [...PROVIDERS];
    let apiKey: string | null = null;
    let providerId: ProviderId | null = null;
    for (const p of providersToTry) {
      const key = await getApiKey(supabase, user.id, p);
      if (key) {
        apiKey = key;
        providerId = p;
        break;
      }
    }
    if (!apiKey || !providerId) {
      return NextResponse.json(
        { error: "No API key configured. Add one in API Key settings." },
        { status: 400 }
      );
    }
    const modelOpt = getModelForProvider(providerId, body.model);
    candidates = [{ providerId, model: modelOpt ?? undefined, apiKey }];
  }

  // Dev bypass fallback: when using X-Dev-Token and no keys in DB, use DEV_OPENROUTER_API_KEY
  if (candidates.length === 0) {
    const devUser = getDevBypassUser(request);
    const devKey = process.env.NODE_ENV === "development" && devUser && process.env.DEV_OPENROUTER_API_KEY;
    if (devKey) {
      candidates = [{
        providerId: "openrouter" as ProviderId,
        model: "openrouter/free",
        apiKey: devKey,
      }];
    }
  }
  if (candidates.length === 0) {
    return NextResponse.json(
      { error: "No API key configured. Add one in API Key settings." },
      { status: 400 }
    );
  }

  const events: DebugFromLogResponse["events"] = [];
  events.push({
    type: "reasoning",
    message: `Debug from logs: analyzing error and workspace (${workspaceName}).`,
    meta: { toolName: "debug-from-log" },
  });

  try {
    const { content } = await invokeChatWithFallback({
      messages: [
        { role: "system", content: DEBUG_SYSTEM },
        { role: "user", content: userMessage },
      ],
      task: "debug",
      candidates,
      userId: user.id,
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
      const safeResponse: DebugFromLogResponse = {
        suspectedRootCause: null,
        explanation: "Could not parse model response as JSON.",
        verificationCommand: null,
        edits: [],
        events,
      };
      events.push({
        type: "status",
        message: "Debug analysis could not parse model output.",
        meta: { toolName: "debug-from-log" },
      });
      return NextResponse.json(safeResponse);
    }

    const validated = validateDebugFromLogOutput(parsed);
    const { suspectedRootCause, explanation, verificationCommand } = validated;
    const rawEdits = validated.edits;
    const edits: DebugFromLogEdit[] = [];
    const invalidEdits: string[] = [];
    
    for (const e of rawEdits) {
      const path = typeof e.path === "string" ? e.path.trim() : "";
      const newContent = typeof e.newContent === "string" ? e.newContent.trim() : "";
      
      if (!path || !newContent) {
        invalidEdits.push(`Edit missing path or newContent`);
        continue;
      }
      
      // Validate path exists in workspace (unless it's a new file)
      const pathExists = pathSet.has(path);
      if (!pathExists && e.oldContent) {
        // Trying to edit a file that doesn't exist
        invalidEdits.push(`Path "${path}" not found in workspace`);
        continue;
      }
      
      // For existing files, oldContent should be provided
      if (pathExists && !e.oldContent) {
        invalidEdits.push(`Edit for existing file "${path}" missing oldContent`);
        // Still include it but warn
      }
      
      edits.push({
        path,
        description: typeof e.description === "string" ? e.description.trim() : undefined,
        oldContent: typeof e.oldContent === "string" && e.oldContent.trim() ? e.oldContent.trim() : undefined,
        newContent,
      });
    }
    
    // Add warning if there were invalid edits
    if (invalidEdits.length > 0 && edits.length === 0) {
      events.push({
        type: "status",
        message: `Warning: ${invalidEdits.length} edit(s) were invalid: ${invalidEdits.join("; ")}`,
        meta: { toolName: "debug-from-log" },
      });
    }

    const affectedPaths = [...new Set(edits.map((e) => e.path))];

    const ev = createAgentEvent("tool_call", "debug-from-log: proposed fixes", {
      toolName: "debug-from-log",
      filePath: affectedPaths[0],
    });
    events.push({
      type: ev.type,
      message: ev.message,
      meta: { ...ev.meta, affectedFiles: affectedPaths },
    });
    events.push({
      type: "reasoning",
      message: `Suspected root cause: ${suspectedRootCause ?? "unknown"}. Files with proposed fixes: ${affectedPaths.join(", ") || "none"}.`,
      meta: { toolName: "debug-from-log" },
    });
    
    if (edits.length > 0) {
      events.push({
        type: "status",
        message: `Proposed ${edits.length} fix(es). These will be tested in a sandbox before applying to your workspace.`,
        meta: { toolName: "debug-from-log" },
      });
    } else if (suspectedRootCause) {
      events.push({
        type: "status",
        message: "Root cause identified but no file edits proposed. The fix may require manual intervention or external changes.",
        meta: { toolName: "debug-from-log" },
      });
    }

    const response: DebugFromLogResponse = {
      suspectedRootCause: suspectedRootCause ?? null,
      explanation: explanation ?? "Analysis complete.",
      verificationCommand: verificationCommand ?? null,
      edits,
      events,
    };
    return NextResponse.json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "LLM request failed";
    console.error("[POST /api/workspaces/[id]/debug-from-log]", e);
    const safeResponse: DebugFromLogResponse = {
      suspectedRootCause: null,
      explanation: `Debug failed: ${msg}`,
      verificationCommand: null,
      edits: [],
      events,
    };
    events.push({
      type: "status",
      message: `Debug-from-log failed: ${msg}`,
      meta: { toolName: "debug-from-log" },
    });
    return NextResponse.json(safeResponse, { status: 500 });
  }
}
