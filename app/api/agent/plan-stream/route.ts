import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";
import { checkRateLimit, getRateLimitIdentifier } from "@/lib/api-rate-limit";
import { getDevBypassUser } from "@/lib/auth-dev-bypass";
import { getProvider, getModelForProvider, OPENROUTER_FREE_MODELS, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { getModelCapabilities, modelMeetsRequirement, findCapableFallback } from "@/lib/llm/model-capabilities";
import { isRateLimitError } from "@/lib/llm/rate-limit";
import type { AgentPlan, FileEditStep, CommandStep, PlanStep } from "@/lib/agent/types";
import type { ScopeMode } from "@/lib/agent/types";
import { computeRunScope, applyScopeCaps } from "@/lib/agent/scope";
import { createAgentEvent, formatStreamEvent, type AgentEvent } from "@/lib/agent-events";
import { detectErrorLogKind } from "@/lib/agent/error-log-utils";
import { classifyErrorLog, getClassificationHint } from "@/lib/agent/error-classifier";
import { safeClose, safeEnqueue, shouldStopStream, createStreamAbortSignal, STREAM_UPSTREAM_TIMEOUT_MS, MAX_STREAM_DURATION_MS } from "@/lib/stream-utils";

/** Timeout for plan parse retry chat calls - prevents indefinite hang on slow/free models. */
const PLAN_RETRY_TIMEOUT_MS = 90_000;
import { enforceAndRecordBudget, refundBudget, BudgetExceededError, ServiceUnavailableError, STREAMING_RESERVE_TOKENS, estimateTokensFromChars } from "@/lib/llm/budget-guard";
import { acquireStreamSlot, releaseStreamSlot } from "@/lib/stream-caps";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { buildIntelligentContext, formatIntelligentContext } from "@/lib/indexing/intelligent-context";
import { learnCodebasePatterns, formatLearnedPatterns } from "@/lib/indexing/pattern-learning";
import { multiStepReasoning } from "@/lib/agent/chain-of-thought";
import { applyEnvRouting } from "@/lib/llm/task-routing";
import { validateToolName, validateToolInput } from "@/services/tools/registry";
import { agentPlanStreamBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";
import { validateDeterministicPlan, hashPlanForValidation } from "@/lib/agent/deterministic-plan-schema";
import { logger, logAgentStarted, logAgentCompleted, getRequestId } from "@/lib/logger";
import { captureException } from "@/lib/sentry";
import { recordAgentPlanDuration, recordLLMBudgetReserved, recordLLMBudgetRefunded, recordLLMBudgetExceeded, recordLLMStreamAbortedTimeout, recordLLMStreamAbortedClient } from "@/lib/metrics";
import { isStreamingEnabled, isWeakModelsEnabled, isOfflineMode } from "@/lib/config";

// Same system prompt as plan route, but with instruction to emit reasoning messages
const PLAN_SYSTEM = `You are an intelligent coding agent planner. Your job is to understand the user's request, analyze the codebase, and create a plan that accomplishes the task.

CRITICAL JSON OUTPUT RULES (NON-NEGOTIABLE):
1. **Return ONLY valid JSON. No markdown. No commentary.** Your response must be a single JSON object.
2. **No leading text** - Do NOT write "Looking at...", "Here's...", "I'll..." before the JSON
3. **No trailing text** - Do NOT add explanations after the JSON
4. **Use double quotes** - Never use single quotes for strings
5. **No trailing commas** - Remove all trailing commas before } or ]
6. **No comments** - Do not include // or /* */ comments in JSON
7. **Valid syntax** - Ensure all commas, braces, and brackets are properly balanced
8. **DO NOT output code** - Do NOT output actual code files, functions, or implementations. Output ONLY a JSON plan with steps.
9. **DO NOT output markdown** - Do NOT wrap the JSON in \`\`\` code blocks. Output raw JSON only.

**REJECTION**: Responses containing non-JSON content, markdown fences, or commentary will be rejected.


IMPORTANT - Show Your Thinking:
As you plan and analyze the task, periodically emit short, user-friendly status messages describing what you are doing. These messages help users understand your reasoning in real-time. Examples:
- "Scanning the codebase to understand the current structure..."
- "Analyzing existing routes and components..."
- "Designing the database schema for user authentication..."
- "Planning to create 5 files: main app component, sign-up form, billing page, product listing, and API routes."
- "Identifying which files need to be modified based on the error logs..."

**CRITICAL**: After your reasoning messages, output ONLY the JSON plan object. Do NOT add any text before or after it.

Keep reasoning messages concise and focused on what you're actively doing or thinking about.

Your approach:
1. **Understand the task**: What is the user asking for? What's the goal?
2. **Understand the codebase**: What files exist? How is the project structured? What patterns are used?
3. **Plan systematically**: Break down the task into logical steps. What needs to be created? What needs to be modified? What needs to be tested?
4. **Think about completeness**: Will the result actually work? Are all dependencies included? Are all configuration files present?
5. **Consider edge cases**: What could go wrong? How can you prevent common errors?

CONSISTENCY AND "THINK FIRST" (CRITICAL — same task must yield same plan every time):
- **Enumerate before JSON**: Before outputting the JSON plan, in your reasoning messages explicitly list the exact set of file paths you will create or modify and the exact commands you will run. Example: "I will create: package.json, app/page.tsx, app/api/products/route.ts, ... and run: npm install, npm run dev." Then output a JSON plan that contains exactly those steps and no others.
- **Canonical structure**: For project/application creation, determine the minimal complete set of deliverables required by the task (e.g. config, pages, API routes, data layer, tests). Use a fixed, canonical order: config first (package.json, requirements.txt, tsconfig, etc.), then entry/app files, then routes/pages, then data/API, then tests, then install commands (npm install, pip install -r requirements.txt), then run/test commands. Same instruction must produce the same number of files and same paths on every run.
- **No random variation**: Do not add optional files, extra pages, or alternate structures "for flexibility." Do not omit files that are required for the task. The plan must be deterministic: re-running the same user instruction should yield the same steps array (same paths and command list). Content inside files can vary; the list of deliverables (paths + commands) must not.
- **One authoritative plan**: Produce exactly one complete plan. Do not output multiple alternatives or "option A / option B." Decide the minimal set that satisfies the task and output that set.

Output format:
1. Reasoning messages (emitted during thinking - see above)
2. **ONLY** a single JSON object with this exact shape (no text before or after):
{
  "steps": [
    { "type": "file_edit", "path": "<file path>", "oldContent": "<exact snippet to replace or omit for full replace>", "newContent": "<new content>", "description": "<optional>" },
    { "type": "command", "command": "<shell command>", "description": "<optional>" }
  ],
  "summary": "<optional short summary>"
}

**CRITICAL - "steps" must be an array of OBJECTS, NOT strings:**
- Each element in "steps" MUST be an object (curly braces {}), never a plain text string.
- WRONG: "steps": ["Modify package.json", "Update README"]  ← strings are invalid
- CORRECT: "steps": [{"type": "file_edit", "path": "package.json", "newContent": "..."}, {"type": "command", "command": "npm start"}]
- Every step object MUST have: "type": "file_edit" or "type": "command"
- file_edit: must also have "path" and "newContent" (both strings)
- command: must also have "command" (string)
- Do NOT put description-only strings in the steps array. Each step must be a full object with type, path/newContent or command.

Rules:
- path must be relative to workspace root (e.g. "src/app/page.tsx").
- For file_edit: include oldContent only when replacing a specific snippet; omit for full file replace.
- Order steps in dependency order (e.g. create file before editing it).
- Use "command" steps for npm install, pip install -r requirements.txt, npm test, etc. Keep commands simple and allowlist-friendly.
- Output ONLY the JSON object, no surrounding text, no markdown code blocks, no Python syntax, no explanatory prefixes like "Looking at..." or "Here's the plan:".
- Start directly with { and end with }. No text before { or after }.

CRITICAL - Step Requirements:
- Every file_edit step MUST have: "type": "file_edit", "path": "<file path>", "newContent": "<content>"
- Every command step MUST have: "type": "command", "command": "<shell command>"
- Do NOT create steps with empty or missing fields. Every step must be complete and valid.

When creating projects or fixing errors:
- **Think about completeness**: Will this actually work? What's needed to make it run?
- **Understand the project structure**: Look at existing files to understand patterns and conventions
- **Consider dependencies**: What packages/libraries are needed? Where should they be declared?
- **Think about configuration**: Are there config files needed? Environment variables? Port settings?
- **Plan for testing**: Include steps to verify the solution works
- **Learn from the codebase**: Use existing patterns, conventions, and structure

When fixing errors or bugs (CRITICAL - minimal edits):
- **Make MINIMAL, surgical edits only.** Never replace or delete large sections of a file unless the user explicitly asked to remove or rewrite them.
- **Prefer oldContent/newContent** for targeted replacements of the specific lines that cause the bug. Do not replace entire files or handlers when fixing a single bug.
- If the user says "fix the error" or "fix the 500", identify the single root cause and change only what is necessary. Do not simplify, refactor, or remove unrelated code.
- **Never delete code the user did not ask to remove.** Preserve existing logic; only fix the faulty part (e.g. a wrong URL, a missing character, a typo).
- **Fix the actual code or config, not only documentation.** When the user reports a runtime error, "port in use", "GET /api/… 500", or similar, you MUST include at least one file_edit step that changes executable code or configuration (e.g. server port, API handler, .env, or config file). Do not add or change only README, HOW_TO_RUN, or comments. The fix must address the root cause in code or config.

When creating projects:
- **Think about completeness**: Will this actually run? Include README or HOW_TO_RUN, dependencies, and verify steps in dependency order.
- **Node**: For any command step like "npm run <script>", ensure your plan includes a step that defines that script (e.g. in package.json) before the command runs. Always run "npm install" before "npm start" or "npm run dev". Check package.json scripts: use "npm start" if no "dev" script. For tests: use "npm test" or "npx jest" when no test script exists.
- **Jest + TypeScript**: If adding Jest tests to a TypeScript project, include a jest.config.js step with: preset: 'ts-jest', testEnvironment: 'node' (or 'jsdom' for DOM/React tests), and moduleNameMapper for path aliases (e.g. '^@/(.*)$': '<rootDir>/src/$1'). Add ts-jest, @types/jest, and jest-environment-jsdom (required for testEnvironment: 'jsdom' since Jest 28) to devDependencies. Without this, Jest will fail with "unexpected token" or "jest-environment-jsdom cannot be found".
- **Python**: Always include requirements.txt in the plan with all dependencies (e.g. flask, fastapi, requests). Create requirements.txt before any Python code that imports those packages. Run "pip install -r requirements.txt" (or "pip3 install -r requirements.txt") before running the app or tests. Order: requirements.txt, app code, then pip install, then python app.py or pytest.
- Use existing codebase patterns and structure.

Remember: Your goal is to create working, maintainable solutions. Think through the problem systematically and use the codebase context to inform your decisions.`;

function emitEvent(controller: ReadableStreamDefaultController, encoder: TextEncoder, event: AgentEvent) {
  try {
    controller.enqueue(encoder.encode(formatStreamEvent(event)));
  } catch (e) {
    console.error("Failed to emit event:", e);
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

  const rl = await checkRateLimit(getRateLimitIdentifier(request, user.id), "agent-plan-stream", 30);
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

  const validation = validateBody(agentPlanStreamBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json(
      { error: validation.error },
      { status: 400 }
    );
  }
  const body = validation.data;

  const instruction = body.instruction;
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

  // Budget check before stream: return 429 with structured body when workspace limit exceeded (enables modal + retry)
  const skipWorkspaceBudget = request.headers.get("X-Budget-Fallback") === "user-only";
  const requestId = getRequestId(request);
  try {
    await enforceAndRecordBudget(supabase, user.id, STREAMING_RESERVE_TOKENS, workspaceId, requestId, {
      skipWorkspaceBudget: skipWorkspaceBudget || undefined,
    });
    recordLLMBudgetReserved(STREAMING_RESERVE_TOKENS);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      recordLLMBudgetExceeded();
      if (e.scope === "workspace" && !skipWorkspaceBudget) {
        return NextResponse.json(
          {
            error: e.message,
            code: "BUDGET_EXCEEDED",
            scope: "workspace",
            canFallbackToUser: true,
            retryAfter: 86400,
          },
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "86400",
            },
          }
        );
      }
      return NextResponse.json(
        { error: e.message, code: "BUDGET_EXCEEDED", scope: e.scope, retryAfter: 86400 },
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "86400" } }
      );
    }
    if (e instanceof ServiceUnavailableError) {
      return NextResponse.json(
        { error: e.message },
        { status: 503, headers: { "Content-Type": "application/json" } }
      );
    }
    throw e;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const planStart = Date.now();
      let planError: Error | null = null;
      let plan: AgentPlan | null = null;
      let raw = "";
      let usage: { inputTokens?: number; outputTokens?: number } | null = null;
      let eventMeta: { modelId?: string; modelLabel?: string; modelGroupId?: string; modelRole?: "planner" | "coder" | "reviewer" } = {};
      const emit = (event: AgentEvent) => {
        if (Object.keys(eventMeta).length > 0) {
          event = { ...event, meta: { ...eventMeta, ...event.meta } };
        }
        emitEvent(controller, encoder, event);
      };

      let abortReason: "timeout" | "client" | null = null;
      try {
        logAgentStarted({
          phase: "plan",
          workspaceId,
          userId: user.id,
          instruction,
          scopeMode: body.scopeMode,
          requestId,
        });
        applyEnvRouting();
        emit(createAgentEvent('status', 'Agent started planning...'));

        const messageKind = detectErrorLogKind(instruction);
        let errorClassification: string | null = null;
        if (messageKind === "error_log") {
          errorClassification = classifyErrorLog(instruction);
          emit(createAgentEvent('reasoning', `Detected error logs (${errorClassification}). Will plan minimal fix from error context.`, { kind: 'error_log' }));
        }

        let apiKey: string | null = null;
        let providerId: ProviderId | null = null;

        const { resolveInvocationConfig, getConfigByRole } = await import("@/lib/models/invocation-config");
        let configs = await resolveInvocationConfig(supabase, user.id, {
          modelId: body.modelId,
          modelGroupId: body.modelGroupId,
        });
        // Dev bypass fallback: when using X-Dev-Token and no keys in DB, use DEV_OPENROUTER_API_KEY
        if (configs.length === 0) {
          const devUser = getDevBypassUser(request);
          const devKey = process.env.NODE_ENV === "development" && devUser && process.env.DEV_OPENROUTER_API_KEY;
          if (devKey) {
            configs = [{
              modelId: "dev-openrouter",
              modelLabel: "OpenRouter (dev)",
              providerId: "openrouter" as ProviderId,
              modelSlug: "openrouter/free",
              apiKey: devKey,
            }];
          }
        }
        if (configs.length === 0) {
          emit(createAgentEvent('status', 'Error: No model selected or no API key for the selected model/group. Add API keys in Settings or Models & groups.'));
          safeClose(controller);
          return;
        }
        const inv = getConfigByRole(configs, "planner") ?? configs[0];
        apiKey = inv.apiKey || "";
        providerId = inv.providerId;
        const modelOpt = inv.modelSlug;
        // When user has only one config, fetch all available models for rate-limit fallback
        if (configs.length === 1) {
          const { resolveDefaultGroup } = await import("@/lib/models/invocation-config");
          const fallbackConfigs = await resolveDefaultGroup(supabase, user.id);
          const currentSlug = inv.modelSlug;
          const extra = fallbackConfigs.filter(
            (c) => (c.apiKey || c.providerId === "ollama") && c.modelSlug !== currentSlug
          );
          if (extra.length > 0) {
            configs = [inv, ...extra];
          }
        }
        eventMeta = {
          modelId: inv.modelId,
          modelLabel: inv.modelLabel,
          modelGroupId: body.modelGroupId ?? undefined,
          modelRole: inv.role ?? "planner",
        };
        if (configs.length > 1) {
          emit(createAgentEvent('reasoning', `Swarm: using ${inv.modelLabel} as planner (${configs.length} models in group).`));
        } else {
          emit(createAgentEvent('reasoning', `Using ${inv.modelLabel}...`));
        }

        if (!providerId || (providerId !== "ollama" && !apiKey)) {
          const triedLabels = PROVIDERS.map((p) => PROVIDER_LABELS[p]).join(", ");
          const errorMsg = `No API key configured. Tried: ${triedLabels}. Add a key in Settings → API Keys.`;
          emit(createAgentEvent('status', `Error: ${errorMsg}`));
          safeClose(controller);
          return;
        }

        const resolvedModel =
          modelOpt ??
          getModelForProvider(providerId, body.model) ??
          (providerId === "openrouter" ? "openrouter/free" : undefined);

        if (!eventMeta.modelId) {
          emit(createAgentEvent('reasoning', `Using ${PROVIDER_LABELS[providerId]}...`));
        }

        let userContent = `Instruction: ${instruction}`;

        // Error-log aware context: structured errorLogs + environment for agent reasoning
        if (messageKind === "error_log" && errorClassification) {
          const env = { os: process.platform, nodeVersion: process.version, framework: "unknown" };
          const hint = getClassificationHint(errorClassification as import("@/lib/agent/error-classifier").ErrorClassification);
          userContent = `**ERROR LOG ANALYSIS REQUEST**

Error classification: ${errorClassification}
Hint: ${hint}

Environment: ${JSON.stringify(env)}

**Error logs (terminal output / stack trace):**
\`\`\`
${instruction.slice(0, 8000)}
\`\`\`

**Your task:**
1. Analyze the error and identify the root cause.
2. Propose a MINIMAL fix (surgical edits only).
3. Explain the root cause in each step's description.
4. Apply the patch via file_edit steps with exact oldContent/newContent.`;
        }

        // Index search
        let indexedFiles: { path: string; line?: number; preview?: string }[] = [];
        if (body.useIndex && workspaceId) {
          validateToolName("search_index");
          try {
            const searchTerms = instruction
              .split(/\s+/)
              .filter((w) => w.length > 3 && !/^(the|and|or|for|with|from)$/i.test(w))
              .slice(0, 5)
              .join(" ");
            validateToolInput("search_index", { query: searchTerms, workspaceId, limit: 15 });
            emit(createAgentEvent('tool_call', 'Searching codebase index...', { toolName: 'search_index' }));
            if (searchTerms) {
              // Use semantic search API for better results
              const origin = request.headers.get("origin") || "http://localhost:3000";
              const searchRes = await fetch(
                `${origin}/api/search?query=${encodeURIComponent(searchTerms)}&workspaceId=${workspaceId}&limit=15&semantic=true`
              );
              
              let chunks: { file_path?: string; content?: string }[] = [];
              if (searchRes.ok) {
                const searchData = await searchRes.json();
                // Fetch full chunk content for results
                if (searchData.results && searchData.results.length > 0) {
                  const paths = [...new Set((searchData.results as { path?: string }[]).map((r) => r.path).filter(Boolean))];
                  const { data: fullChunks } = await supabase
                    .from("code_chunks")
                    .select("file_path, content, symbols, chunk_index")
                    .eq("workspace_id", workspaceId)
                    .in("file_path", paths)
                    .limit(15);
                  chunks = fullChunks || [];
                }
              }
              
              // Fallback to text search if semantic search didn't return results
              if (chunks.length === 0) {
                const { data: textChunks } = await supabase
                  .from("code_chunks")
                  .select("file_path, content, symbols, chunk_index")
                  .eq("workspace_id", workspaceId)
                  .ilike("content", `%${searchTerms}%`)
                  .limit(15);
                chunks = textChunks || [];
              }
              
              if (chunks) {
                const queryLower = searchTerms.toLowerCase();
                const resultsMap = new Map();
                
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
                  
                  const existing = resultsMap.get(path);
                  if (!existing) {
                    resultsMap.set(path, {
                      path,
                      line: matchLine,
                      preview: preview.slice(0, 500),
                    });
                  }
                }
                indexedFiles = Array.from(resultsMap.values()).slice(0, 5);
              }
            }
            emit(createAgentEvent('tool_result', `Found ${indexedFiles.length} relevant files in index`, { toolName: 'search_index' }));
          } catch {
            emit(createAgentEvent('tool_result', 'Index search failed, continuing without it', { toolName: 'search_index' }));
          }
        }

        if (body.fileList?.length) {
          emit(createAgentEvent('reasoning', `Analyzing ${body.fileList.length} files in workspace...`));
          userContent += `\n\nFiles in workspace (paths):\n${body.fileList.join("\n")}`;
        }
        
        // Detect error logs and extract file paths/line numbers
        const errorPatterns = [
          /(?:File|file|at)\s+["']?([^\s"']+\.(?:py|js|ts|tsx|jsx|java|rb|go|rs|cpp|c|h))["']?\s*(?:,\s*line\s+(\d+)|:\d+)/gi,
          /(?:in|at)\s+([^\s"']+\.(?:py|js|ts|tsx|jsx|java|rb|go|rs|cpp|c|h))(?:\s*:\s*(\d+))?/gi,
          /Traceback[\s\S]*?File\s+["']([^"']+)["'][\s\S]*?line\s+(\d+)/gi,
          /Error.*?([^\s"']+\.(?:py|js|ts|tsx|jsx))(?:\s*:\s*(\d+))?/gi,
        ];
        
        const errorFiles = new Set<string>();
        for (const pattern of errorPatterns) {
          let match;
          while ((match = pattern.exec(instruction)) !== null) {
            const filePath = match[1] || match[2];
            if (filePath) {
              // Normalize path (remove leading ./ or /)
              const normalized = filePath.replace(/^\.\//, "").replace(/^\//, "");
              errorFiles.add(normalized);
            }
          }
        }
        
        // Auto-read files mentioned in errors if they exist in workspace
        const filesToRead = new Set<string>(body.fileContents ? Object.keys(body.fileContents) : []);
        if (errorFiles.size > 0 && workspaceId) {
          const detectedFiles = Array.from(errorFiles);
          emit(createAgentEvent('reasoning', `Detected error logs mentioning ${errorFiles.size} file(s): ${detectedFiles.join(', ')}`));
          
          // Try to match error files with workspace files (handle variations)
          const workspaceFiles = body.fileList || [];
          const matchedFiles: string[] = [];
          
          for (const errorFile of errorFiles) {
            // Try exact match first
            if (workspaceFiles.includes(errorFile)) {
              if (!filesToRead.has(errorFile)) {
                filesToRead.add(errorFile);
                matchedFiles.push(errorFile);
              }
            } else {
              // Try partial matches (e.g., "app.py" matches "src/app.py")
              const matched = workspaceFiles.find(wf => 
                wf.endsWith(errorFile) || 
                wf.includes(errorFile) ||
                errorFile.includes(wf.split('/').pop() || '')
              );
              if (matched && !filesToRead.has(matched)) {
                filesToRead.add(matched);
                matchedFiles.push(matched);
              }
            }
          }
          
          if (matchedFiles.length > 0) {
            emit(createAgentEvent('reasoning', `Found ${matchedFiles.length} matching file(s) in workspace, reading them...`));
          } else if (errorFiles.size > 0) {
            emit(createAgentEvent('reasoning', `Warning: Files mentioned in errors (${detectedFiles.join(', ')}) were not found in workspace. The agent will need to create them or work with existing files.`));
          }
          
          // Fetch file contents for error-related files
          if (filesToRead.size > 0) {
            const { data: fileRows } = await supabase
              .from("workspace_files")
              .select("path, content")
              .eq("workspace_id", workspaceId)
              .in("path", Array.from(filesToRead));
            
            if (fileRows && fileRows.length > 0) {
              if (!body.fileContents) body.fileContents = {};
              for (const row of fileRows) {
                if (!body.fileContents[row.path]) {
                  body.fileContents[row.path] = row.content || "";
                }
              }
              emit(createAgentEvent('reasoning', `Read ${fileRows.length} file(s) for error analysis`));
            }
          }
        }
        
        if (indexedFiles.length > 0) {
          userContent += "\n\nRelevant codebase context (from semantic search):\n";
          for (const result of indexedFiles) {
            userContent += `\n--- ${result.path}${result.line ? ` (line ${result.line})` : ""} ---\n${result.preview}\n`;
          }
        }

        // Build intelligent context automatically (codebase structure, relationships, dependencies)
        try {
          const intelligentContext = await buildIntelligentContext(
            supabase,
            workspaceId,
            null, // Could detect current file from instruction
            instruction
          );
          const formattedContext = formatIntelligentContext(intelligentContext);
          if (formattedContext.trim()) {
            userContent += "\n\nCodebase structure and relationships (discovered automatically):\n";
            userContent += formattedContext;
          }

          // Learn patterns from codebase
          const learnedPatterns = await learnCodebasePatterns(supabase, workspaceId);
          const patternsText = formatLearnedPatterns(learnedPatterns);
          if (patternsText.trim()) {
            userContent += "\n\nLearned codebase patterns:\n";
            userContent += patternsText;
          }
        } catch (e) {
          console.error("Failed to build intelligent context:", e);
          // Continue without it
        }
        
        // Always re-read latest file contents from workspace before planning (avoids stale state after user edits)
        if (workspaceId && (body.fileList?.length || (body.fileContents && Object.keys(body.fileContents).length > 0))) {
          const pathsToRead = body.fileList?.length
            ? body.fileList
            : Object.keys(body.fileContents ?? {});
          if (pathsToRead.length > 0) {
            const { data: freshRows } = await supabase
              .from("workspace_files")
              .select("path, content")
              .eq("workspace_id", workspaceId)
              .in("path", pathsToRead);
            if (freshRows?.length) {
              if (!body.fileContents) body.fileContents = {};
              for (const row of freshRows) {
                body.fileContents[row.path] = row.content ?? "";
              }
            }
          }
        }

        if (body.fileContents && Object.keys(body.fileContents).length > 0) {
          validateToolName("read_file");
          emit(createAgentEvent('reasoning', `Reading ${Object.keys(body.fileContents).length} file(s)...`));
          userContent += "\n\nRelevant file contents (path -> content):\n";
          for (const [path, content] of Object.entries(body.fileContents)) {
            try {
              validateToolInput("read_file", { path });
            } catch {
              continue; // Skip invalid paths
            }
            emit(createAgentEvent('tool_call', `Reading file ${path}`, { toolName: 'read_file', filePath: path }));
            userContent += `\n--- ${path} ---\n${String(content).slice(0, 8000)}\n`;
          }
        }

        emit(createAgentEvent('reasoning', 'Generating plan...'));
        
        // Build configs for fallback: when one model hits rate limit, try next available model from user's account
        type ConfigTry = { providerId: ProviderId; apiKey: string; modelSlug: string; modelLabel: string };
        let configsToTry: ConfigTry[] = [];
        if (configs.length > 1) {
          // Use all configs for fallback (different providers/models)
          for (const c of configs) {
            if (c.apiKey || c.providerId === "ollama") {
              configsToTry.push({
                providerId: c.providerId,
                apiKey: c.apiKey ?? "",
                modelSlug: c.modelSlug ?? getModelForProvider(c.providerId, null) ?? "openrouter/free",
                modelLabel: c.modelLabel,
              });
            }
          }
        }
        if (configsToTry.length === 0) {
          const freeModelIds = OPENROUTER_FREE_MODELS.map((m) => m.id);
          const modelsForProvider =
            providerId === "openrouter" && resolvedModel && (freeModelIds as readonly string[]).includes(resolvedModel)
              ? [...freeModelIds]
              : resolvedModel
                ? [resolvedModel]
                : [];
          for (const m of modelsForProvider) {
            configsToTry.push({
              providerId: providerId!,
              apiKey: apiKey ?? "",
              modelSlug: m,
              modelLabel: inv.modelLabel,
            });
          }
        }
        // Production safe mode: exclude weak/free-tier models when WEAK_MODELS_ENABLED=false
        let configsFiltered = configsToTry;
        if (!isWeakModelsEnabled()) {
          configsFiltered = configsToTry.filter((c) => {
            const cap = getModelCapabilities(c.providerId, c.modelSlug);
            return !cap?.rateLimited;
          });
          if (configsFiltered.length === 0) {
            emit(createAgentEvent("status", "Error: No non-free models configured. Add an API key or set WEAK_MODELS_ENABLED=true."));
            safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: "error", error: "No models available. Add API key or enable weak models.", code: "NO_MODELS" })}\n\n`);
            safeClose(controller);
            return;
          }
          configsToTry = configsFiltered;
        }
        // Reorder: prefer models that support streaming + planning (per capability registry)
        const PLANNING_REQUIREMENTS = ["streaming", "planning"] as const;
        configsToTry.sort((a, b) => {
          const aMeets = PLANNING_REQUIREMENTS.every((r) => modelMeetsRequirement(a.providerId, a.modelSlug, r));
          const bMeets = PLANNING_REQUIREMENTS.every((r) => modelMeetsRequirement(b.providerId, b.modelSlug, r));
          if (aMeets && !bMeets) return -1;
          if (!aMeets && bMeets) return 1;
          return 0;
        });
        let modelFallback: { from: string; to: string; reason?: "rate_limit" | "capability" } | null = null;
        const providerErrors: string[] = [];
        // Proactive switch: if first model doesn't support streaming, switch to one that does
        const first = configsToTry[0];
        if (first && !modelMeetsRequirement(first.providerId, first.modelSlug, "streaming")) {
          const capable = configsToTry.find((c) => modelMeetsRequirement(c.providerId, c.modelSlug, "streaming"));
          if (capable && capable !== first) {
            const idx = configsToTry.indexOf(capable);
            if (idx > 0) {
              [configsToTry[0], configsToTry[idx]] = [configsToTry[idx], configsToTry[0]];
              emit(createAgentEvent("reasoning", `Model ${first.modelLabel} doesn't support streaming. Using ${capable.modelLabel} instead.`));
              emit(createAgentEvent("status", `Model ${first.modelLabel} doesn't support streaming. Using ${capable.modelLabel} instead.`));
              modelFallback = { from: first.modelLabel, to: capable.modelLabel, reason: "capability" };
            }
          }
        }
        const provider = getProvider(configsToTry[0]?.providerId ?? providerId!);
        let modelUsed = configsToTry[0]?.modelSlug ?? resolvedModel ?? undefined;
        let winningConfig: ConfigTry | null = configsToTry[0] ?? null;

        // Load project rules
        const rules = await loadRules(supabase, workspaceId);
        const rulesPrompt = formatRulesForPrompt(rules);
        const systemPromptWithRules = PLAN_SYSTEM + rulesPrompt;
        
        // Use direct planning by default. Only use chain-of-thought for genuinely complex creation tasks.
        const lowerInstruction = instruction.toLowerCase();
        const looksLikeErrorFix =
          lowerInstruction.includes("eaddrinuse") ||
          (lowerInstruction.includes("port") && (lowerInstruction.includes("already in use") || lowerInstruction.includes("in use") || lowerInstruction.includes("conflict"))) ||
          (lowerInstruction.includes("error") && (lowerInstruction.includes("fix") || lowerInstruction.includes("address already in use"))) ||
          lowerInstruction.includes("traceback") ||
          lowerInstruction.includes("exception") ||
          messageKind === "error_log";
        const looksLikeSimpleRequest =
          instruction.length < 500 &&
          instruction.split("\n").length <= 10 &&
          !(lowerInstruction.includes("create") && (lowerInstruction.includes("application") || lowerInstruction.includes("full ") || lowerInstruction.includes("entire ")));
        const isComplexTask =
          !looksLikeErrorFix &&
          !looksLikeSimpleRequest &&
          (instruction.length > 400 &&
            (lowerInstruction.includes("create") || lowerInstruction.includes("build")) &&
            (lowerInstruction.includes("application") ||
              lowerInstruction.includes("from scratch") ||
              lowerInstruction.includes("full project") ||
              lowerInstruction.includes("architecture") ||
              lowerInstruction.includes("e-commerce") ||
              lowerInstruction.includes("3-tier") ||
              lowerInstruction.includes("tier")));

        // Only for rare, genuinely complex creation tasks: use chain-of-thought. Otherwise use fast direct planning.
        if (!isComplexTask && (looksLikeErrorFix || looksLikeSimpleRequest)) {
          emit(createAgentEvent('reasoning', 'Using direct planning for fast response...'));
        }
        if (isComplexTask) {
          emit(createAgentEvent('reasoning', 'Using multi-step reasoning for complex task...'));
          const COT_TIMEOUT_MS = 90_000;
          const HEARTBEAT_MS = 45_000;
          const heartbeat = setInterval(() => {
            emit(createAgentEvent('reasoning', 'Still reasoning... (complex tasks can take 1–2 min)'));
          }, HEARTBEAT_MS);
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), COT_TIMEOUT_MS));

          try {
            const reasoningResult = await Promise.race([
              multiStepReasoning(instruction, userContent, { apiKey, providerId, model: resolvedModel }),
              timeoutPromise,
            ]);
            clearInterval(heartbeat);
            if (reasoningResult === null) {
              emit(createAgentEvent('reasoning', 'Reasoning took too long; using direct planning for faster response.'));
              plan = null;
            } else {
              if (reasoningResult.reasoning.steps.length > 0) {
                emit(createAgentEvent('reasoning', `Reasoned through ${reasoningResult.reasoning.steps.length} steps`));
                for (const step of reasoningResult.reasoning.steps.slice(0, 5)) {
                  emit(createAgentEvent('reasoning', `Step ${step.step}: ${step.thought}`));
                }
              }
              if (reasoningResult.plan) {
                const cotPlan = reasoningResult.plan;
                const hasStringSteps = Array.isArray(cotPlan.steps) && cotPlan.steps.length > 0 && cotPlan.steps.every((s: unknown) => typeof s === "string");
                if (hasStringSteps) {
                  emit(createAgentEvent('reasoning', `Reasoning returned text descriptions instead of step objects; using direct planning instead.`));
                  plan = null;
                } else {
                  plan = cotPlan;
                  emit(createAgentEvent('reasoning', `Plan generated from reasoning: ${plan.steps.length} step(s)`));
                }
              }
            }
          } catch (e) {
            clearInterval(heartbeat);
            const reasoningError = e instanceof Error ? e.message : "Unknown error";
            console.error("Chain-of-thought reasoning failed, falling back to direct planning:", e);
            emit(createAgentEvent('reasoning', `Chain-of-thought failed: ${reasoningError}. Falling back to direct planning...`));
          }
        }

        // Use streaming to get real-time output (if plan not already generated)
        let buffer = "";
        let lastEmitTime = Date.now();
        
        if (!plan) {
          // Validate API key before attempting to call provider
          if (!apiKey) {
            throw new Error(`No API key configured for ${PROVIDER_LABELS[providerId]}. Please add an API key in Settings → API Keys.`);
          }

          let streamDone = false;
          for (let i = 0; i < configsToTry.length && !streamDone; i++) {
            const cfg = configsToTry[i];
            const tryProvider = getProvider(cfg.providerId);
            const tryModel = cfg.modelSlug;
            if (i > 0) {
              const prevLabel = configsToTry[i - 1].modelLabel;
              providerErrors.push(`${prevLabel}: rate limit or quota exceeded`);
              emit(createAgentEvent("reasoning", `Model ${prevLabel} hit limits. Switched to ${cfg.modelLabel} to complete the task.`));
              emit(createAgentEvent("status", `Model ${prevLabel} hit limits. Switched to ${cfg.modelLabel} to complete the task.`));
              modelFallback = { from: configsToTry[0].modelLabel, to: cfg.modelLabel, reason: "rate_limit" };
            }
            raw = "";
            buffer = "";
            lastEmitTime = Date.now();
            const streamStartTime = Date.now();
            usage = null;
            const streamAbortSignal = createStreamAbortSignal(request, MAX_STREAM_DURATION_MS, (r) => { abortReason = r; });
            const useStreaming = isStreamingEnabled() && modelMeetsRequirement(cfg.providerId, tryModel, "streaming");
            try {
            if (useStreaming) {
            for await (const chunk of tryProvider.stream(
            [
              { role: "system", content: systemPromptWithRules },
              { role: "user", content: userContent },
            ],
            cfg.apiKey,
            { model: tryModel, temperature: 0, topP: 1, signal: streamAbortSignal }
          )) {
            if (shouldStopStream(request, streamStartTime, STREAM_UPSTREAM_TIMEOUT_MS)) break;
            raw += chunk;
            buffer += chunk;
            
            const now = Date.now();
            const timeSinceLastEmit = now - lastEmitTime;
            
            // Detect if JSON is starting (look for opening brace or bracket)
            const jsonStartIdx = buffer.search(/[{[]/);
            const hasJsonStart = jsonStartIdx !== -1;
            
            // Emit reasoning chunks:
            // 1. When we hit sentence boundaries (natural breaks)
            // 2. When buffer gets large (>80 chars)
            // 3. Every ~300ms to show progress
            // 4. Right before JSON starts (to capture any reasoning before JSON)
            
            const sentenceEnd = /[.!?]\s+/.exec(buffer);
            const hasNewline = buffer.includes('\n');
            const shouldEmit = 
              (hasJsonStart && jsonStartIdx > 0) || // Emit reasoning before JSON starts
              sentenceEnd || 
              hasNewline || 
              buffer.length > 80 || 
              timeSinceLastEmit > 300;
            
            if (shouldEmit && buffer.trim()) {
              let toEmit = "";
              let isBeforeJson = false;
              
              if (hasJsonStart && jsonStartIdx > 0) {
                // Emit everything before JSON starts
                toEmit = buffer.slice(0, jsonStartIdx).trim();
                buffer = buffer.slice(jsonStartIdx);
                isBeforeJson = true;
              } else if (sentenceEnd) {
                toEmit = buffer.slice(0, sentenceEnd.index! + sentenceEnd[0].length).trim();
                buffer = buffer.slice(sentenceEnd.index! + sentenceEnd[0].length);
              } else if (hasNewline) {
                const newlineIdx = buffer.indexOf('\n');
                toEmit = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
              } else if (buffer.length > 80) {
                toEmit = buffer.slice(0, 80).trim();
                buffer = buffer.slice(80);
              } else if (timeSinceLastEmit > 300) {
                toEmit = buffer.trim();
                buffer = "";
              }
              
              if (toEmit) {
                // Clean up markdown code blocks
                const cleaned = toEmit
                  .replace(/^```json\s*/i, "")
                  .replace(/^```\s*/, "")
                  .replace(/\s*```$/, "")
                  .trim();
                
                // Check if it's reasoning text (not pure JSON structure)
                const isPureJsonStructure = /^[\s{[\],:"]+$/.test(cleaned);
                const looksLikeReasoning = cleaned.length > 10 && 
                  !cleaned.startsWith('{') && 
                  !cleaned.startsWith('[') &&
                  !isPureJsonStructure;
                
                if (cleaned && (looksLikeReasoning || isBeforeJson)) {
                  emit(createAgentEvent('reasoning', cleaned));
                  lastEmitTime = now;
                } else if (cleaned && cleaned.length > 5 && !hasJsonStart) {
                  // Show progress even for JSON-like chunks if we haven't seen JSON start yet
                  emit(createAgentEvent('reasoning', 'Generating plan structure...'));
                  lastEmitTime = now;
                }
              }
            }
          }

          // Emit any remaining buffer
          if (buffer.trim()) {
            const cleaned = buffer.trim()
              .replace(/^```json\s*/i, "")
              .replace(/^```\s*/, "")
              .replace(/\s*```$/, "")
              .trim();
            if (cleaned && !/^[\s{[\],:"]+$/.test(cleaned)) {
              emit(createAgentEvent('reasoning', cleaned));
            }
          }
            } else {
              emit(createAgentEvent('reasoning', 'Using non-streaming mode (STREAMING_ENABLED=false or model does not support streaming).'));
              const chatResponse = await tryProvider.chat(
                [
                  { role: "system", content: systemPromptWithRules },
                  { role: "user", content: userContent },
                ],
                cfg.apiKey,
                { model: tryModel, temperature: 0, topP: 1, signal: streamAbortSignal }
              );
              raw = chatResponse.content ?? "";
              usage = chatResponse.usage ?? null;
            }
            modelUsed = tryModel;
            winningConfig = cfg;
            streamDone = true;
            } catch (streamError) {
              const streamErrorMsg = streamError instanceof Error ? streamError.message : "Unknown stream error";
              if (streamErrorMsg.includes("API key") || streamErrorMsg.includes("authentication") || streamErrorMsg.includes("401") || streamErrorMsg.includes("403")) {
                throw new Error(`API authentication failed: ${streamErrorMsg}. Please check your API key in Settings → API Keys.`);
              }
              if (isRateLimitError(streamError) && i < configsToTry.length - 1) {
                continue;
              }
              emit(createAgentEvent('reasoning', `Streaming failed: ${streamErrorMsg}. Trying non-streaming mode...`));
              try {
                const fallback = await tryProvider.chat(
                  [
                    { role: "system", content: systemPromptWithRules },
                    { role: "user", content: userContent },
                  ],
                  cfg.apiKey,
                  { model: tryModel, temperature: 0, topP: 1 }
                );
                raw = fallback.content;
                usage = fallback.usage ?? null;
                modelUsed = tryModel;
                winningConfig = cfg;
                streamDone = true;
              } catch (fallbackError) {
                if (isRateLimitError(fallbackError) && i < configsToTry.length - 1) {
                  continue;
                }
                const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : "Unknown fallback error";
                const allExhausted = i >= configsToTry.length - 1 && (isRateLimitError(streamError) || isRateLimitError(fallbackError));
                if (allExhausted) {
                  const exhaustedEvent = {
                    type: "error",
                    code: "ALL_MODELS_EXHAUSTED",
                    error: "All available AI models are currently rate-limited or out of quota.",
                    message: "Model X unavailable, switched to Y. All models exhausted.",
                    recommendedProviders: [...new Set(configsToTry.map((c) => c.providerId))],
                    recommendedModels: [...new Set(configsToTry.map((c) => c.modelSlug))],
                  };
                  safeEnqueue(controller, encoder, `data: ${JSON.stringify(exhaustedEvent)}\n\n`);
                  safeClose(controller);
                  return;
                }
                throw new Error(`Both streaming and non-streaming requests failed. Streaming error: ${streamErrorMsg}. Fallback error: ${fallbackMsg}`);
              }
            }
          }
        } // End of "if (!plan)" block

        // Parse plan from streaming response (if not already generated from chain-of-thought)
        if (!plan) {
          let trimmed = raw.trim();

          // Handle empty or missing response (e.g. Perplexity sometimes returns no content)
          if (!trimmed) {
            emit(createAgentEvent('status', 'Model returned no content; retrying with same provider...'));
            let emptyRetryRaw = "";
            if (winningConfig) {
              try {
                const retryProvider = getProvider(winningConfig.providerId);
                const retryAbort = new AbortController();
                const retryTimeout = setTimeout(() => retryAbort.abort(), PLAN_RETRY_TIMEOUT_MS);
                const retryResponse = await retryProvider.chat(
                  [
                    { role: "system", content: systemPromptWithRules },
                    { role: "user", content: userContent },
                  ],
                  winningConfig.apiKey,
                  { model: winningConfig.modelSlug, temperature: 0, topP: 1, signal: retryAbort.signal }
                );
                clearTimeout(retryTimeout);
                emptyRetryRaw = (retryResponse.content || "").trim();
              } catch {
                emit(createAgentEvent('reasoning', 'Same-provider retry failed. Trying fallback provider...'));
              }
            }
            if (!emptyRetryRaw && configsToTry.length > 1 && winningConfig) {
              const fallbackIdx = configsToTry.findIndex((c) => c.providerId === winningConfig!.providerId && c.modelSlug === winningConfig!.modelSlug);
              const fallbackConfig = findCapableFallback(configsToTry, fallbackIdx >= 0 ? fallbackIdx : 0, ["planning"]);
              if (fallbackConfig) {
                emit(createAgentEvent('status', `Trying fallback provider ${fallbackConfig.modelLabel}...`));
                try {
                  const fallbackProvider = getProvider(fallbackConfig.providerId);
                  const fallbackAbort = new AbortController();
                  const fallbackTimeout = setTimeout(() => fallbackAbort.abort(), PLAN_RETRY_TIMEOUT_MS);
                  const fallbackResponse = await fallbackProvider.chat(
                    [
                      { role: "system", content: systemPromptWithRules },
                      { role: "user", content: userContent },
                    ],
                    fallbackConfig.apiKey,
                    { model: fallbackConfig.modelSlug, temperature: 0, topP: 1, signal: fallbackAbort.signal }
                  );
                  clearTimeout(fallbackTimeout);
                  emptyRetryRaw = (fallbackResponse.content || "").trim();
                  if (emptyRetryRaw) {
                    modelUsed = fallbackConfig.modelSlug;
                    winningConfig = fallbackConfig;
                    emit(createAgentEvent('reasoning', `Fallback provider succeeded: got ${emptyRetryRaw.length} chars.`));
                  }
                } catch {
                  emit(createAgentEvent('reasoning', 'Fallback provider retry failed.'));
                }
              }
            }
            const finalRaw = emptyRetryRaw || trimmed;
            if (!finalRaw) {
              emit(createAgentEvent('status', 'Error: The model returned no content'));
              emit(createAgentEvent('reasoning', 'The model returned an empty response after retries. Try a different provider (e.g. OpenRouter or Gemini) or retry.'));
              safeEnqueue(controller, encoder, `data: ${JSON.stringify({ type: 'error', error: 'The model returned no content. Try a different provider (e.g. OpenRouter or Gemini) or retry.', code: 'EMPTY_RESPONSE' })}\n\n`);
              safeClose(controller);
              return;
            }
            raw = finalRaw;
            trimmed = finalRaw;
          }

          emit(createAgentEvent('reasoning', 'Parsing plan response...'));

          const { extractAgentPlanJSON } = await import("@/lib/utils/json-parser");
          const { logError, createStructuredError } = await import("@/lib/utils/error-handler");

          const safeErrorStr = (err: unknown): string =>
            typeof err === "string" ? err : err instanceof Error ? err.message : err != null ? JSON.stringify(err) : "Unknown error";

          let currentRaw = trimmed;
          let parseResult = extractAgentPlanJSON<AgentPlan>(currentRaw, ["steps"]);
          let lastError = safeErrorStr(parseResult.error);

          // Phase 3: Retry-on-parse-failure: 1 retry with same provider, then fallback provider
          const MAX_PARSE_RETRIES = 1;
          for (let retry = 0; retry <= MAX_PARSE_RETRIES; retry++) {
            if (parseResult.success && parseResult.data) {
              const schemaValidation = validateDeterministicPlan(parseResult.data);
              if (schemaValidation.success && schemaValidation.plan.steps?.length) {
                plan = schemaValidation.plan;
                if (retry > 0) emit(createAgentEvent('reasoning', `Retry ${retry} succeeded: got valid JSON plan.`));
                break;
              }
              lastError = schemaValidation.success ? "Plan has no steps" : schemaValidation.error;
            } else {
              lastError = safeErrorStr(parseResult.error);
            }

            if (plan) break;
            if (retry < MAX_PARSE_RETRIES && winningConfig) {
              emit(createAgentEvent('status', `Plan parse failed; retrying (${retry + 1}/${MAX_PARSE_RETRIES})...`));
              const fixHint = `\n\n[System: Your previous response had invalid JSON or schema errors. Fix and output ONLY valid JSON. No markdown. No commentary.\nError: ${lastError}\nRaw output (first 2000 chars):\n${currentRaw.slice(0, 2000)}]\n\n`;
              const retryModel = modelUsed || winningConfig.modelSlug;
              const retryProvider = getProvider(winningConfig.providerId);
              const retryAbort = new AbortController();
              const retryTimeout = setTimeout(() => retryAbort.abort(), PLAN_RETRY_TIMEOUT_MS);
              try {
                const retryResponse = await retryProvider.chat(
                  [
                    { role: "system", content: systemPromptWithRules },
                    { role: "user", content: userContent + fixHint },
                  ],
                  winningConfig.apiKey,
                  { model: retryModel, temperature: 0, topP: 1, signal: retryAbort.signal }
                );
                clearTimeout(retryTimeout);
                currentRaw = (retryResponse.content || "").trim();
                if (!currentRaw) {
                  emit(createAgentEvent('reasoning', 'Retry returned empty response.'));
                  break;
                }
                parseResult = extractAgentPlanJSON<AgentPlan>(currentRaw, ["steps"]);
              } catch (retryErr) {
                clearTimeout(retryTimeout);
                const msg = retryErr instanceof Error ? retryErr.message : "Unknown error";
                const isTimeout = /abort|timeout|timed out/i.test(msg);
                console.warn("Plan parse retry failed:", retryErr);
                emit(createAgentEvent('reasoning', `Retry ${retry + 1} failed: ${isTimeout ? "Request timed out. Try a different model." : msg}`));
                break;
              }
            }
          }

          if (!plan && configsToTry.length > 1 && winningConfig) {
            const currentIdx = configsToTry.findIndex((c) => c.providerId === winningConfig!.providerId && c.modelSlug === winningConfig!.modelSlug);
            const fallbackConfig = findCapableFallback(configsToTry, currentIdx >= 0 ? currentIdx : 0, ["planning"]);
            if (fallbackConfig) {
              emit(createAgentEvent('status', `Parse failed with primary provider; retrying with fallback ${fallbackConfig.modelLabel}...`));
              const fixHint = `\n\n[System: Your previous response had invalid JSON or schema errors. Fix and output ONLY valid JSON. No markdown. No commentary.\nError: ${lastError}\nOutput ONLY a JSON object with "steps" array. Each step: {"type":"file_edit","path":"...","newContent":"..."} or {"type":"command","command":"..."}]\n\n`;
              try {
                const fallbackProvider = getProvider(fallbackConfig.providerId);
                const fallbackAbort = new AbortController();
                const fallbackTimeout = setTimeout(() => fallbackAbort.abort(), PLAN_RETRY_TIMEOUT_MS);
                const fallbackResponse = await fallbackProvider.chat(
                  [
                    { role: "system", content: systemPromptWithRules },
                    { role: "user", content: userContent + fixHint },
                  ],
                  fallbackConfig.apiKey,
                  { model: fallbackConfig.modelSlug, temperature: 0, topP: 1, signal: fallbackAbort.signal }
                );
                clearTimeout(fallbackTimeout);
                const fallbackRaw = (fallbackResponse.content || "").trim();
                if (fallbackRaw) {
                  const fallbackParse = extractAgentPlanJSON<AgentPlan>(fallbackRaw, ["steps"]);
                  if (fallbackParse.success && fallbackParse.data) {
                    const schemaCheck = validateDeterministicPlan(fallbackParse.data);
                    if (schemaCheck.success && schemaCheck.plan.steps?.length) {
                      plan = schemaCheck.plan;
                      modelUsed = fallbackConfig.modelSlug;
                      winningConfig = fallbackConfig;
                      emit(createAgentEvent('reasoning', `Fallback provider succeeded: got valid plan with ${plan.steps.length} step(s).`));
                    }
                  }
                }
              } catch (fallbackErr) {
                console.warn("Fallback provider parse retry failed:", fallbackErr);
                emit(createAgentEvent('reasoning', 'Fallback provider retry failed.'));
              }
            }
          }

          if (!plan) {
            // Reject: code instead of JSON (no JSON object found)
            const looksLikeCode = (
              trimmed.includes("margin:") ||
              trimmed.includes("font-family:") ||
              trimmed.includes("def ") ||
              trimmed.includes("function ") ||
              trimmed.includes("import ") ||
              trimmed.includes("const ") ||
              trimmed.includes("class ") ||
              trimmed.includes("export ") ||
              trimmed.includes("require(") ||
              trimmed.includes("from ")
            );
            const hasNoJson = trimmed.indexOf("{") === -1;
            if (looksLikeCode && hasNoJson) {
              emit(createAgentEvent('status', 'Error: LLM returned code instead of JSON plan'));
              emit(createAgentEvent('reasoning', 'The model returned code instead of a JSON plan. Try rephrasing as a task request (e.g., "Create a file X" or "Add feature Y").'));
            }

            // Phase 5: Hard failure with structured INVALID_AGENT_PLAN error
            logError(
              createStructuredError(
                `Plan JSON parse failed after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError}`,
                "parsing",
                "high",
                { raw: parseResult.raw || currentRaw.slice(0, 500), originalLength: currentRaw.length }
              )
            );
            const structuredError = {
              type: "error",
              code: "AGENT_PROTOCOL_FAILURE",
              message: "The AI failed to produce a valid execution plan. Try a different model or provider.",
            };
            emit(createAgentEvent('status', `Error: ${structuredError.message}`));
            safeEnqueue(controller, encoder, `data: ${JSON.stringify(structuredError)}\n\n`);
            safeClose(controller);
            return;
          }
        } // End of "if (!plan)" parsing block

        // Retry once when model returns valid JSON but empty steps (common with some OpenRouter/free models)
        if (plan && Array.isArray(plan.steps) && plan.steps.length === 0 && winningConfig) {
          const retrySuffix = "\n\n[System: Your previous response had an empty \"steps\" array. You MUST output a JSON object with a non-empty \"steps\" array. Each step must be an object with \"type\" (\"file_edit\" or \"command\"), and for file_edit: \"path\" and \"newContent\"; for command: \"command\". Output ONLY valid JSON, no markdown or extra text.]";
          emit(createAgentEvent('status', 'Model returned empty steps; retrying once with stronger prompt...'));
          emit(createAgentEvent('reasoning', 'Retrying plan generation (empty steps array).'));
          const emptyStepsAbort = new AbortController();
          const emptyStepsTimeout = setTimeout(() => emptyStepsAbort.abort(), PLAN_RETRY_TIMEOUT_MS);
          try {
            const retryModel = modelUsed || winningConfig.modelSlug;
            const retryProvider = getProvider(winningConfig.providerId);
            const retryResponse = await retryProvider.chat(
              [
                { role: "system", content: systemPromptWithRules },
                { role: "user", content: userContent + retrySuffix },
              ],
              winningConfig.apiKey,
              { model: retryModel, temperature: 0, topP: 1, signal: emptyStepsAbort.signal }
            );
            clearTimeout(emptyStepsTimeout);
            const retryRaw = (retryResponse.content || "").trim();
            if (retryRaw) {
              const { extractAgentPlanJSON } = await import("@/lib/utils/json-parser");
              const retryResult = extractAgentPlanJSON<AgentPlan>(retryRaw, ["steps"]);
              if (retryResult.success && retryResult.data) {
                const schemaCheck = validateDeterministicPlan(retryResult.data);
                if (schemaCheck.success && schemaCheck.plan.steps?.length) {
                  plan = schemaCheck.plan;
                  emit(createAgentEvent('reasoning', `Retry succeeded: got ${plan.steps.length} step(s).`));
                }
              }
            }
          } catch (retryErr) {
            clearTimeout(emptyStepsTimeout);
            console.warn("Empty-steps retry failed:", retryErr);
            emit(createAgentEvent('reasoning', 'Retry failed; will report empty plan.'));
          }
        }

        // Validate: any "npm run <script>" must have a prior step that defines that script (e.g. in package.json)
        function missingNpmScripts(p: AgentPlan): string[] {
          const steps = Array.isArray(p.steps) ? p.steps : [];
          const scriptUsed = new Set<string>();
          for (const s of steps) {
            if (s?.type === "command" && typeof (s as CommandStep).command === "string") {
              const m = (s as CommandStep).command.trim().match(/^npm\s+run\s+(\S+)/);
              if (m) scriptUsed.add(m[1]);
            }
          }
          if (scriptUsed.size === 0) return [];
          const packageJsonContent = steps
            .filter((s: PlanStep): s is FileEditStep => s?.type === "file_edit" && (s.path === "package.json" || s.path?.endsWith("/package.json")))
            .map((s) => (s.newContent || ""))
            .join("\n");
          const missing: string[] = [];
          for (const script of scriptUsed) {
            if (!packageJsonContent.includes(`"${script}"`) && !packageJsonContent.includes(`'${script}'`))
              missing.push(script);
          }
          return missing;
        }

        if (plan && Array.isArray(plan.steps) && plan.steps.length > 0 && winningConfig) {
          const missing = missingNpmScripts(plan);
          if (missing.length > 0) {
            const scriptsList = missing.join(", ");
            emit(createAgentEvent('reasoning', `Plan runs "npm run ${scriptsList}" but no step defines ${missing.length === 1 ? "this script" : "these scripts"} in package.json. Asking the model to correct the plan.`));
            const scriptsForPrompt = missing.map((s) => '"' + s + '"').join(", ");
            const hint = "\n\n[System: Your plan includes command(s) \"npm run " + scriptsList + "\" but no file_edit step that adds " + (missing.length === 1 ? "this script" : "these scripts") + " to package.json. Add or adjust a package.json step so that \"scripts\" includes " + scriptsForPrompt + " (e.g. \"dev\": \"next dev\" or \"vite\"). Then output the corrected JSON plan only.]";
            try {
              const retryModel = modelUsed || winningConfig.modelSlug;
              const retryProvider = getProvider(winningConfig.providerId);
              const retryResponse = await retryProvider.chat(
                [
                  { role: "system", content: systemPromptWithRules },
                  { role: "user", content: userContent + hint },
                ],
                winningConfig.apiKey,
                { model: retryModel, temperature: 0, topP: 1 }
              );
              const retryRaw = (retryResponse.content || "").trim();
              if (retryRaw) {
                const { extractAgentPlanJSON } = await import("@/lib/utils/json-parser");
                const retryResult = extractAgentPlanJSON<AgentPlan>(retryRaw, ["steps"]);
                if (retryResult.success && retryResult.data) {
                  const schemaCheck = validateDeterministicPlan(retryResult.data);
                  if (schemaCheck.success && schemaCheck.plan.steps?.length) {
                    const stillMissing = missingNpmScripts(schemaCheck.plan);
                    if (stillMissing.length === 0) {
                      plan = schemaCheck.plan;
                      emit(createAgentEvent('reasoning', `Plan corrected: package.json now defines required script(s).`));
                    }
                  }
                }
              }
            } catch (retryErr) {
              console.warn("npm-script validation retry failed:", retryErr);
            }
            // If still missing after retry: patch package.json step or inject one
            const stillMissing = plan ? missingNpmScripts(plan) : [];
            if (stillMissing.length > 0 && workspaceId && plan?.steps) {
              const defaultScripts: Record<string, string> = {
                dev: "next dev",
                start: "next start",
                build: "next build",
                test: "vitest run",
              };
              try {
                const pkgIdx = plan.steps.findIndex((st): st is FileEditStep => st?.type === "file_edit" && (st.path === "package.json" || st.path?.endsWith("/package.json")));
                let pkg: Record<string, unknown>;
                const pkgStep = pkgIdx >= 0 ? (plan.steps[pkgIdx] as FileEditStep) : null;
                if (pkgStep?.newContent) {
                  try {
                    pkg = JSON.parse(pkgStep.newContent);
                  } catch {
                    pkg = { name: "app", version: "1.0.0" };
                  }
                } else {
                  const { data: pkgRows } = await supabase
                    .from("workspace_files")
                    .select("path, content")
                    .eq("workspace_id", workspaceId)
                    .in("path", ["package.json"]);
                  pkg = pkgRows?.[0]?.content ? (() => {
                    try { return JSON.parse(pkgRows[0].content as string); } catch { return {}; }
                  })() : { name: "app", version: "1.0.0" };
                }
                if (!pkg || typeof pkg !== "object") pkg = { name: "app", version: "1.0.0" };
                if (!pkg.name) pkg.name = "app";
                if (!pkg.version) pkg.version = "1.0.0";
                const scripts: Record<string, string> = (pkg.scripts && typeof pkg.scripts === "object") ? { ...(pkg.scripts as Record<string, string>) } : {};
                for (const s of stillMissing) {
                  const cmd = defaultScripts[s as keyof typeof defaultScripts] || "echo 'Add script'";
                  scripts[s] = scripts[s] || cmd;
                  if (s === "dev" && cmd.startsWith("next ") && (!pkg.dependencies || !(pkg.dependencies as Record<string, string>).next)) {
                    const deps: Record<string, string> = (pkg.dependencies && typeof pkg.dependencies === "object") ? { ...(pkg.dependencies as Record<string, string>) } : {};
                    deps.next = deps.next || "^14.0.0";
                    pkg.dependencies = deps;
                  }
                }
                pkg.scripts = scripts;
                const newContent = JSON.stringify(pkg, null, 2);
                if (pkgIdx >= 0 && pkgStep) {
                  pkgStep.newContent = newContent;
                  emit(createAgentEvent('reasoning', `Patched package.json step to add scripts: ${stillMissing.join(", ")}`));
                } else {
                  plan.steps.unshift({ type: "file_edit" as const, path: "package.json", newContent, description: `Add scripts: ${stillMissing.join(", ")}` });
                  emit(createAgentEvent('reasoning', `Injected package.json step to add scripts: ${stillMissing.join(", ")}`));
                }
              } catch (injectErr) {
                console.warn("Failed to inject/patch package.json step:", injectErr);
              }
            }
          }
        }

        if (!plan || !Array.isArray(plan.steps)) {
          console.error("Invalid plan structure:", plan);
          emit(createAgentEvent('status', 'Error: Invalid plan (missing steps array)'));
          if (plan && typeof plan === 'object') {
            emit(createAgentEvent('reasoning', `Plan object keys: ${Object.keys(plan).join(', ')}`));
            emit(createAgentEvent('reasoning', `Plan structure: ${JSON.stringify(plan, null, 2).slice(0, 500)}`));
          }
          safeClose(controller);
          return;
        }
        
        // Validate steps array structure
        if (!Array.isArray(plan.steps)) {
          emit(createAgentEvent('status', `Error: Plan steps is not an array. Got: ${typeof plan.steps}`));
          emit(createAgentEvent('reasoning', `Plan structure: ${JSON.stringify(plan, null, 2).slice(0, 1000)}`));
          safeClose(controller);
          return;
        }
        
        // Check if steps might be nested (common LLM mistake)
        if (plan.steps.length > 0 && Array.isArray(plan.steps[0])) {
          console.warn("Steps appear to be nested arrays, attempting to flatten");
          plan.steps = plan.steps.flat();
        }
        
        // Check if steps are strings (descriptions) instead of objects - common LLM mistake
        const allStepsAreStrings = plan.steps.length > 0 && plan.steps.every((s: unknown) => typeof s === "string");
        if (allStepsAreStrings && winningConfig) {
          emit(createAgentEvent('status', 'Steps were plain text; retrying with hint for proper step objects...'));
          const hint = "\n\n[System: Your previous response had \"steps\" as an array of STRINGS (e.g. [\"Create file X\", \"Run npm install\"]). WRONG. Each step MUST be an OBJECT: {\"type\": \"file_edit\", \"path\": \"...\", \"newContent\": \"...\"} or {\"type\": \"command\", \"command\": \"...\"}. Output ONLY valid JSON with step objects.]";
          try {
            const retryModel = modelUsed || winningConfig.modelSlug;
            const retryProvider = getProvider(winningConfig.providerId);
            const retryResponse = await retryProvider.chat(
              [
                { role: "system", content: systemPromptWithRules },
                { role: "user", content: userContent + hint },
              ],
              winningConfig.apiKey,
              { model: retryModel, temperature: 0, topP: 1 }
            );
            const retryRaw = (retryResponse.content || "").trim();
            if (retryRaw) {
              const { extractAgentPlanJSON } = await import("@/lib/utils/json-parser");
              const retryResult = extractAgentPlanJSON<AgentPlan>(retryRaw, ["steps"]);
              if (retryResult.success && retryResult.data) {
                const schemaCheck = validateDeterministicPlan(retryResult.data);
                if (schemaCheck.success && schemaCheck.plan.steps?.length) {
                  plan = schemaCheck.plan;
                  emit(createAgentEvent('reasoning', 'Retry succeeded: got proper step objects.'));
                }
              }
            }
          } catch (retryErr) {
            console.warn("String-steps retry failed:", retryErr);
          }
        }
        if (allStepsAreStrings && (!plan || plan.steps.some((s: unknown) => typeof s === "string"))) {
          emit(createAgentEvent('status', 'Error: Plan steps are plain text descriptions instead of step objects.'));
          emit(createAgentEvent('reasoning', 'Each step must be an OBJECT with type, path/newContent or command.'));
          safeClose(controller);
          return;
        }
        
        // Validate that steps have required fields
        if (!plan) {
          safeClose(controller);
          return;
        }
        const invalidSteps: Array<{ index: number; step: unknown; reason: string }> = [];
        plan.steps.forEach((step: PlanStep, index: number) => {
          if (!step || typeof step !== "object") {
            invalidSteps.push({ 
              index, 
              step, 
              reason: `Step is not an object. Got: ${typeof step}${step ? ` (${JSON.stringify(step).slice(0, 100)})` : ""}` 
            });
            return;
          }
          
          // Log step structure for debugging
          const stepKeys = Object.keys(step);
          const stepPreview = JSON.stringify(step, null, 2).slice(0, 300);
          
          if (!step.type) {
            invalidSteps.push({ 
              index, 
              step, 
              reason: `Missing 'type' field. Step has keys: [${stepKeys.join(", ")}]. Step data: ${stepPreview}` 
            });
            return;
          }
          
          if (step.type === "file_edit") {
            if (!step.path || typeof step.path !== "string" || step.path.trim() === "") {
              invalidSteps.push({ 
                index, 
                step, 
                reason: `Missing or empty 'path' field. Step keys: [${stepKeys.join(", ")}]` 
              });
            }
            if (!step.newContent || typeof step.newContent !== "string") {
              invalidSteps.push({ 
                index, 
                step, 
                reason: `Missing or invalid 'newContent' field. Step keys: [${stepKeys.join(", ")}]` 
              });
            }
          } else if (step.type === "command") {
            if (!step.command || typeof step.command !== "string" || step.command.trim() === "") {
              invalidSteps.push({ 
                index, 
                step, 
                reason: `Missing or empty 'command' field. Step keys: [${stepKeys.join(", ")}]` 
              });
            }
          } else {
            const stepType = (step as { type?: string }).type;
            invalidSteps.push({ 
              index, 
              step, 
              reason: `Unknown step type: "${stepType}". Expected "file_edit" or "command". Step keys: [${stepKeys.join(", ")}]. Step data: ${stepPreview}` 
            });
          }
        });
        
        // Filter out invalid steps
        const validSteps = plan.steps.filter((step: PlanStep, index: number) => {
          return !invalidSteps.some(inv => inv.index === index);
        });
        
        if (validSteps.length === 0) {
          const errorDetails = invalidSteps.length > 0
            ? `\n\nInvalid steps:\n${invalidSteps.map(({ index, reason, step }) => 
                `  Step ${index + 1}: ${reason}\n    Full step: ${JSON.stringify(step, null, 2).slice(0, 400)}`
              ).join("\n\n")}`
            : "";
          const emptyStepsMessage = plan.steps.length === 0
            ? "Error: The model returned no steps (empty plan). Try again, use a different model (e.g. another OpenRouter model), or rephrase the task."
            : `Error: Plan has no valid steps. All ${plan.steps.length} step(s) are missing required fields.${errorDetails}`;
          emit(createAgentEvent('status', emptyStepsMessage));
          emit(createAgentEvent('reasoning', `Full plan structure: ${JSON.stringify(plan, null, 2).slice(0, 1000)}`));
          console.error("Invalid plan steps:", JSON.stringify(plan.steps, null, 2));
          safeClose(controller);
          return;
        }
        
        // Use validated steps
        plan.steps = validSteps;
        
        if (invalidSteps.length > 0) {
          console.warn(`Plan has ${invalidSteps.length} invalid step(s) out of ${plan.steps.length + invalidSteps.length} total:`, invalidSteps);
          emit(createAgentEvent('reasoning', `Warning: ${invalidSteps.length} invalid step(s) were filtered out`));
        }

        // Error-fix path filter: for error-fix intents, require at least one edit outside docs/README
        const docsOnlyPatterns = /^(README|HOW_TO_RUN|CONTRIBUTING|CHANGELOG)(\.\w+)?$/i;
        const isDocsOnlyPath = (path: string) => {
          const p = (path || "").trim();
          if (!p) return true;
          const base = p.split("/").pop() ?? p;
          if (docsOnlyPatterns.test(base)) return true;
          if (/^docs\//i.test(p) || /\.(md|mdx|txt)$/i.test(p)) return true;
          return false;
        };
        const fileEditPaths = plan.steps.filter((s): s is FileEditStep => s.type === "file_edit").map((s) => (s.path || "").trim());
        const hasNonDocsEdit = fileEditPaths.some((p: string) => !isDocsOnlyPath(p));
        if (looksLikeErrorFix && fileEditPaths.length > 0 && !hasNonDocsEdit) {
          emit(createAgentEvent('status', 'Warning: This looks like an error fix but the plan only touches documentation (e.g. README, .md). The fix should change code or config. Try rephrasing or ask to "fix the code" explicitly.'));
          emit(createAgentEvent('reasoning', 'For runtime errors (port in use, 500, etc.), include at least one file_edit to executable code or config, not only README/docs.'));
        }

        const scopeMode: ScopeMode = body.scopeMode ?? "normal";
        const { steps: cappedSteps, trimmed, message: capMessage } = applyScopeCaps(
          plan.steps,
          scopeMode,
          errorFiles.size > 0 ? errorFiles : undefined
        );
        if (trimmed && capMessage) {
          plan.steps = cappedSteps;
          emit(createAgentEvent('status', capMessage, { scopeMode }));
        }

        const fileEditSteps = plan.steps.filter((s): s is FileEditStep => s.type === "file_edit");
        const scope = computeRunScope(fileEditSteps);
        const modeLabel = scopeMode === "conservative" ? "Conservative" : scopeMode === "aggressive" ? "Aggressive" : "Normal";
        emit(createAgentEvent('status', `Planned changes: ${scope.fileCount} file(s), ≈${scope.approxLinesChanged} lines (mode: ${modeLabel}).`, {
          scope: { fileCount: scope.fileCount, approxLinesChanged: scope.approxLinesChanged },
          scopeMode,
        }));

        if (plan.steps.length === 0) {
          console.error("Empty steps array in plan");
          console.error("Raw response (first 1000 chars):", raw.slice(0, 1000));
          console.error("Parsed plan:", JSON.stringify(plan, null, 2));
          emit(createAgentEvent('status', 'Error: Plan has no steps. The model may need more context or clearer instructions.'));
          emit(createAgentEvent('reasoning', 'The model returned a plan but with no steps. This might happen if:'));
          emit(createAgentEvent('reasoning', '1. Files mentioned in errors were not found in the workspace'));
          emit(createAgentEvent('reasoning', '2. The error logs are unclear or incomplete'));
          emit(createAgentEvent('reasoning', '3. The model needs more specific instructions'));
          emit(createAgentEvent('reasoning', 'Try: Including file paths in your error description, or asking to "fix the error in [filename]"'));
          safeClose(controller);
          return;
        }

        emit(createAgentEvent('reasoning', `Plan generated: ${plan.steps.length} step(s)`));

        // Emit final result
        emit(createAgentEvent('status', 'Planning complete', {
          stepCount: plan.steps.length,
        }));

        const contextUsedFilePaths = [...new Set([
          ...indexedFiles.map((r: { path: string }) => r.path),
          ...(body.fileContents ? Object.keys(body.fileContents) : []),
        ])];

        const fileEditStepsForScope = plan.steps.filter((s): s is FileEditStep => s.type === "file_edit");
        const finalScope = computeRunScope(fileEditStepsForScope);
        const durationMs = Date.now() - planStart;

        // Send the plan as a final event (include model info for free-model fallback UI)
        const planHash = hashPlanForValidation(plan);
        safeEnqueue(controller, encoder, `data: ${JSON.stringify({
          type: 'plan',
          plan,
          planHash,
          usage,
          modelUsed: modelUsed ?? undefined,
          modelFallback: modelFallback ?? undefined,
          availableFreeModels: providerId === 'openrouter' ? OPENROUTER_FREE_MODELS.map((m) => ({ id: m.id, label: m.label })) : undefined,
          contextUsed: contextUsedFilePaths.length > 0 ? { filePaths: contextUsedFilePaths } : undefined,
          scope: { fileCount: finalScope.fileCount, approxLinesChanged: finalScope.approxLinesChanged },
          scopeMode: scopeMode ?? "normal",
          durationMs,
          tokensReserved: STREAMING_RESERVE_TOKENS,
          providerErrors: providerErrors.length > 0 ? providerErrors : undefined,
        })}\n\n`);
        safeClose(controller);
      } catch (e) {
        planError = e instanceof Error ? e : new Error(String(e));
        const errorMsg = planError.message;
        const errorStack = planError.stack;
        
        // Emit detailed error information
        emit(createAgentEvent('status', `Error: ${errorMsg}`));
        emit(createAgentEvent('reasoning', `Planning failed with error: ${errorMsg}`));
        
        // Log additional context if available
        if (errorStack) {
          logger.error({ event: "plan_error_stack", error: errorStack });
        }
        logger.error({ event: "plan_generation_error", error: errorMsg, workspaceId, userId: user.id });
        captureException(planError, { workspaceId, operation: "agent_plan", userId: user.id });
        
        // Try to send error details in the response
        safeEnqueue(controller, encoder, `data: ${JSON.stringify({ 
          type: 'error', 
          error: errorMsg,
          details: errorStack ? errorStack.split('\n').slice(0, 5).join('\n') : undefined
        })}\n\n`);
        
        safeClose(controller);
      } finally {
        releaseStreamSlot(user.id, workspaceId);
        if (abortReason === "timeout") recordLLMStreamAbortedTimeout();
        if (abortReason === "client") recordLLMStreamAbortedClient();
        if (raw && raw.length > 0) {
          const tokensUsed = estimateTokensFromChars(raw.length);
          const toRefund = Math.max(0, STREAMING_RESERVE_TOKENS - tokensUsed);
          if (toRefund > 0) {
            refundBudget(supabase, user.id, toRefund, workspaceId).catch(() => {});
            recordLLMBudgetRefunded(toRefund);
          }
        }
        const durationMs = Date.now() - planStart;
        recordAgentPlanDuration(durationMs);
        logAgentCompleted({
          phase: "plan",
          workspaceId,
          userId: user.id,
          durationMs,
          success: !planError,
          error: planError?.message,
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
