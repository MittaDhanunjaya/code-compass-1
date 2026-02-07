import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan } from "@/lib/agent/types";
import { createAgentEvent, formatStreamEvent, type AgentEvent } from "@/lib/agent-events";
import { detectErrorLogKind } from "@/lib/agent/error-log-utils";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";

// Same system prompt as plan route, but with instruction to emit reasoning messages
const PLAN_SYSTEM = `You are a coding agent planner. Given a user instruction and optional workspace context, you should think through the task and then output a JSON plan.

CRITICAL: You MUST output valid JSON only. Use double quotes for all strings, not single quotes. Do not use Python dictionary syntax.

IMPORTANT - Show Your Thinking:
As you plan and analyze the task, periodically emit short, user-friendly status messages describing what you are doing. These messages help users understand your reasoning in real-time. Examples:
- "Scanning the codebase to understand the current structure..."
- "Analyzing existing routes and components..."
- "Designing the database schema for user authentication..."
- "Planning to create 5 files: main app component, sign-up form, billing page, product listing, and API routes."
- "Identifying which files need to be modified based on the error logs..."

Before outputting the JSON plan, briefly explain your approach (1-3 sentences). Then output the JSON plan.

Keep reasoning messages concise and focused on what you're actively doing or thinking about.

Output format:
1. Brief reasoning/explanation (optional but helpful)
2. A single JSON object with this exact shape:
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

CRITICAL - Create WORKING, RUNNABLE Projects:
When creating a new project or application, you MUST ensure it actually runs and works. The application will be tested in a sandbox before being delivered to the user. If it doesn't run, it will be rejected.

QUALITY REQUIREMENTS:
1. **Testability**: Every project MUST be runnable. Include all dependencies, configuration files, and setup steps.
2. **Completeness**: Don't create partial implementations. If you're building an app, make sure it has all necessary files to actually run.
3. **Error Prevention**: Think through common errors:
   - Missing dependencies? Add them to package.json/requirements.txt
   - Missing environment variables? Create .env.example
   - Port conflicts? Use environment variables for ports
   - Import errors? Check all file paths and exports
   - Missing scripts? Add proper start/dev scripts
4. **Verification**: After creating files, include command steps to verify the app works:
   - Install dependencies first
   - Then run the app to verify it starts
   - Fix any errors that appear

IMPORTANT - Create Complete Projects:
When creating a new project or application, ALWAYS include ALL necessary supporting files:

For Python projects (CRITICAL - ALWAYS FOLLOW THESE RULES):
- STEP 1: ALWAYS create a virtual environment FIRST as the FIRST command step: "python3 -m venv venv"
- STEP 2: Create requirements.txt with all dependencies (even if empty initially, include it)
- STEP 3: For ALL pip install commands, ALWAYS use venv's pip: "venv/bin/pip install -r requirements.txt" (NEVER use system pip or pip3)
- STEP 4: For running Python scripts, ALWAYS use venv's python: "venv/bin/python script.py" (NEVER use system python or python3)
- Create README.md with project description, setup instructions, usage examples
- Create .gitignore with Python-specific ignores (__pycache__, *.pyc, venv/, .env, etc.)
- Include virtual environment setup instructions in README (python3 -m venv venv, source venv/bin/activate, pip install -r requirements.txt)
- If the project needs environment variables, create a .env.example file
- CRITICAL: The command order MUST be: 1) python3 -m venv venv, 2) venv/bin/pip install commands, 3) venv/bin/python run commands
- NEVER use "pip install", "pip3 install", "python script.py", or "python3 script.py" - ALWAYS use "venv/bin/pip" and "venv/bin/python" after venv creation

For Node.js/TypeScript projects:
- Create package.json with name, version, scripts, dependencies
- Create README.md with project description, setup instructions (npm install), usage examples
- Create .gitignore with Node-specific ignores (node_modules/, .next/, dist/, .env, etc.)
- Create tsconfig.json if TypeScript is used
- Include npm install command step

For any project:
- ALWAYS create a run-instructions document: either README.md (with a clear "How to run" section) OR a dedicated HOW_TO_RUN.txt. This document is MANDATORY and must list exact step-by-step instructions to run the application or complete the sample task (e.g. create venv, install dependencies, run command, or open URL). Never skip this.
- Always create a README.md explaining what the project does, how to set it up, and how to run it (or HOW_TO_RUN.txt if the task is minimal)
- Include a .gitignore appropriate for the project type
- Add setup/installation commands as command steps (e.g., "npm install", "pip install -r requirements.txt")
- Structure files logically (e.g., src/, lib/, tests/ directories when appropriate)

Example for Python project: If user asks for "a weather app in Python", create:
1. Main application file (weather_app.py)
2. requirements.txt with dependencies (e.g., "requests")
3. README.md with full setup and usage instructions
4. .gitignore with Python patterns
5. Command steps in THIS EXACT ORDER:
   - Step 1: "python3 -m venv venv" (create virtual environment)
   - Step 2: "venv/bin/pip install -r requirements.txt" (install dependencies)
   - Step 3: "venv/bin/python weather_app.py" (run the app)

Example for Node.js project: If user asks for "a weather app in Node", create:
1. Main application file (app.js)
2. package.json with dependencies
3. README.md with full setup and usage instructions
4. .gitignore with Node patterns
5. Command step: "npm install"

Do NOT create only the main file - always include supporting files for a complete, production-ready project.
Do NOT use system pip/python for Python projects - ALWAYS create venv first and use venv/bin/pip and venv/bin/python.

RUN INSTRUCTIONS (MANDATORY): Every plan MUST include at least one file that documents how to run the app or complete the task: README.md (with "How to run" / "Usage" section) or HOW_TO_RUN.txt. The content must be concrete steps (e.g. "1. Create venv: python3 -m venv venv 2. Install: venv/bin/pip install -r requirements.txt 3. Run: venv/bin/python main.py").

CRITICAL - Application Must Actually Run:
After creating all files, you MUST include command steps to:
1. Install dependencies (npm install, pip install, etc.)
2. Run the application (npm start, npm run dev, python app.py, etc.)
3. Verify it starts without errors

If the application fails to run, your plan will be rejected. Think through:
- Are all imports correct?
- Are all dependencies listed?
- Are configuration files present?
- Are environment variables set up?
- Does the main entry point exist and work?

The sandbox will test that your application actually runs. If it fails, you must fix the errors before the plan is accepted.

CRITICAL - Fixing Errors and Debugging:
When the user provides error logs, stack traces, or asks to fix existing code:
1. FIRST: Identify which files are mentioned in the error (file paths, line numbers, function names)
2. Read those files from the workspace context (they should be provided in fileContents or fileList)
3. Parse the error message to understand:
   - What type of error it is (syntax error, import error, runtime error, type error, etc.)
   - Which line(s) are causing the problem
   - What the expected vs actual behavior is
4. Make MINIMAL, TARGETED fixes:
   - Only edit the specific files that need changes
   - Use oldContent/newContent to replace only the problematic sections
   - Don't recreate entire files unless absolutely necessary
   - Preserve working code that isn't related to the error
5. After fixing, include a command step to test/run the code to verify the fix works
6. If the error mentions missing dependencies, add them to requirements.txt/package.json and include an install command

IMPORTANT: You MUST ALWAYS return at least one step in your plan. Even if you're unsure, make your best attempt:
- If files are mentioned in errors but not found in workspace, create them or note the issue
- If the error is unclear, make reasonable assumptions based on common error patterns
- Always include at least one file_edit step to address the error

Example: If user says "I got this error: NameError: name 'x' is not defined at line 5 in app.py", you should:
- Read app.py from the workspace (or create it if missing)
- Find line 5 and the surrounding context
- Fix the specific issue (define 'x', fix typo, etc.) using oldContent/newContent
- Include a command step to test: "venv/bin/python app.py" or similar
- Don't rewrite the entire file unless it's necessary

When fixing errors, prioritize understanding the root cause and making the smallest change that fixes it. NEVER return an empty steps array - always provide at least one fix attempt.`;

function emitEvent(controller: ReadableStreamDefaultController, encoder: TextEncoder, event: AgentEvent) {
  try {
    controller.enqueue(encoder.encode(formatStreamEvent(event)));
  } catch (e) {
    console.error("Failed to emit event:", e);
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

  let body: {
    instruction?: string;
    workspaceId?: string;
    provider?: ProviderId;
    model?: string;
    fileList?: string[];
    fileContents?: Record<string, string>;
    useIndex?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const instruction = (body.instruction ?? "").trim();
  if (!instruction) {
    return NextResponse.json(
      { error: "instruction is required" },
      { status: 400 }
    );
  }

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "No active workspace selected" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        emitEvent(controller, encoder, createAgentEvent('status', 'Agent started planning...'));

        const messageKind = detectErrorLogKind(instruction);
        if (messageKind === "error_log") {
          emitEvent(controller, encoder, createAgentEvent('reasoning', 'Detected runtime logs; will plan fixes from error context.', { kind: 'error_log' }));
        }

        const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
        const providersToTry = PROVIDERS.includes(requestedProvider)
          ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
          : [...PROVIDERS];

        let apiKey: string | null = null;
        let providerId: ProviderId | null = null;
        
        emitEvent(controller, encoder, createAgentEvent('reasoning', 'Checking API keys...'));
        
        for (const p of providersToTry) {
          const { data: keyRow } = await supabase
            .from("provider_keys")
            .select("key_encrypted")
            .eq("user_id", user.id)
            .eq("provider", p)
            .single();
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
          const requestedLabel = requestedProvider ? PROVIDER_LABELS[requestedProvider] : "Selected provider";
          emitEvent(controller, encoder, createAgentEvent('status', `Error: No API key configured for ${requestedLabel}`));
          controller.close();
          return;
        }

        emitEvent(controller, encoder, createAgentEvent('reasoning', `Using ${PROVIDER_LABELS[providerId]}...`));

        let userContent = `Instruction: ${instruction}`;
        
        // Index search
        let indexedFiles: any[] = [];
        if (body.useIndex && workspaceId) {
          emitEvent(controller, encoder, createAgentEvent('tool_call', 'Searching codebase index...', { toolName: 'search_index' }));
          try {
            const searchTerms = instruction
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
            emitEvent(controller, encoder, createAgentEvent('tool_result', `Found ${indexedFiles.length} relevant files in index`, { toolName: 'search_index' }));
          } catch (e) {
            emitEvent(controller, encoder, createAgentEvent('tool_result', 'Index search failed, continuing without it', { toolName: 'search_index' }));
          }
        }

        if (body.fileList?.length) {
          emitEvent(controller, encoder, createAgentEvent('reasoning', `Analyzing ${body.fileList.length} files in workspace...`));
          userContent += `\n\nFiles in workspace (paths):\n${body.fileList.join("\n")}`;
        }
        
        // Detect error logs and extract file paths/line numbers
        const errorPatterns = [
          /(?:File|file|at)\s+["']?([^\s"']+\.(?:py|js|ts|tsx|jsx|java|rb|go|rs|cpp|c|h))["']?\s*(?:,\s*line\s+(\d+)|:\d+)/gi,
          /(?:in|at)\s+([^\s"']+\.(?:py|js|ts|tsx|jsx|java|rb|go|rs|cpp|c|h))(?:\s*:\s*(\d+))?/gi,
          /Traceback.*?File\s+["']([^"']+)["'].*?line\s+(\d+)/gis,
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
          emitEvent(controller, encoder, createAgentEvent('reasoning', `Detected error logs mentioning ${errorFiles.size} file(s): ${detectedFiles.join(', ')}`));
          
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
            emitEvent(controller, encoder, createAgentEvent('reasoning', `Found ${matchedFiles.length} matching file(s) in workspace, reading them...`));
          } else if (errorFiles.size > 0) {
            emitEvent(controller, encoder, createAgentEvent('reasoning', `Warning: Files mentioned in errors (${detectedFiles.join(', ')}) were not found in workspace. The agent will need to create them or work with existing files.`));
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
              emitEvent(controller, encoder, createAgentEvent('reasoning', `Read ${fileRows.length} file(s) for error analysis`));
            }
          }
        }
        
        if (indexedFiles.length > 0) {
          userContent += "\n\nRelevant codebase context (from index):\n";
          for (const result of indexedFiles) {
            userContent += `\n--- ${result.path}${result.line ? ` (line ${result.line})` : ""} ---\n${result.preview}\n`;
          }
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
          emitEvent(controller, encoder, createAgentEvent('reasoning', `Reading ${Object.keys(body.fileContents).length} file(s)...`));
          userContent += "\n\nRelevant file contents (path -> content):\n";
          for (const [path, content] of Object.entries(body.fileContents)) {
            emitEvent(controller, encoder, createAgentEvent('tool_call', `Reading file ${path}`, { toolName: 'read_file', filePath: path }));
            userContent += `\n--- ${path} ---\n${content.slice(0, 8000)}\n`;
          }
        }

        emitEvent(controller, encoder, createAgentEvent('reasoning', 'Generating plan...'));
        
        const provider = getProvider(providerId);
        const modelOpt = getModelForProvider(providerId, body.model);
        
        // Use streaming to get real-time output
        let raw = "";
        let buffer = "";
        let lastEmitTime = Date.now();
        let usage: any = null;
        
        try {
          for await (const chunk of provider.stream(
            [
              { role: "system", content: PLAN_SYSTEM },
              { role: "user", content: userContent },
            ],
            apiKey,
            { model: modelOpt }
          )) {
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
                let cleaned = toEmit
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
                  emitEvent(controller, encoder, createAgentEvent('reasoning', cleaned));
                  lastEmitTime = now;
                } else if (cleaned && cleaned.length > 5 && !hasJsonStart) {
                  // Show progress even for JSON-like chunks if we haven't seen JSON start yet
                  emitEvent(controller, encoder, createAgentEvent('reasoning', 'Generating plan structure...'));
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
              emitEvent(controller, encoder, createAgentEvent('reasoning', cleaned));
            }
          }
        } catch (streamError) {
          // If streaming fails, fall back to non-streaming (this is normal for some providers/models)
          emitEvent(controller, encoder, createAgentEvent('reasoning', 'Generating plan (non-streaming mode)...'));
          const fallback = await provider.chat(
            [
              { role: "system", content: PLAN_SYSTEM },
              { role: "user", content: userContent },
            ],
            apiKey,
            { model: modelOpt }
          );
          raw = fallback.content;
          usage = fallback.usage;
        }

        emitEvent(controller, encoder, createAgentEvent('reasoning', 'Parsing plan response...'));

        const trimmed = raw.trim();
        if (
          trimmed.startsWith("{") === false &&
          trimmed.startsWith("[") === false &&
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
            emitEvent(controller, encoder, createAgentEvent('status', 'Error: LLM returned code instead of JSON plan'));
            controller.close();
            return;
          }
        }

        /** Extract first complete JSON object by balanced braces (skips content inside double-quoted strings). */
        function extractJsonObject(text: string): string | null {
          const start = text.indexOf("{");
          if (start === -1) return null;
          let depth = 0;
          let inString = false;
          let escape = false;
          const q = '"';
          for (let i = start; i < text.length; i++) {
            const c = text[i];
            if (escape) {
              escape = false;
              continue;
            }
            if (c === "\\" && inString) {
              escape = true;
              continue;
            }
            if (inString) {
              if (c === q) inString = false;
              continue;
            }
            if (c === q) {
              inString = true;
              continue;
            }
            if (c === "{") depth++;
            else if (c === "}") {
              depth--;
              if (depth === 0) return text.slice(start, i + 1);
            }
          }
          return null;
        }

        let jsonStr = trimmed;
        // 1) Prefer content inside ```json ... ``` or ``` ... ```
        const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (codeBlock) {
          jsonStr = codeBlock[1].trim();
        }
        // 2) Try balanced-brace extraction (handles leading/trailing text and nested objects)
        let extracted = extractJsonObject(jsonStr);
        if (extracted && extracted.includes('"steps"')) {
          jsonStr = extracted;
        } else {
          const fallback = extractJsonObject(trimmed);
          if (fallback && fallback.includes('"steps"')) {
            jsonStr = fallback;
          } else if (extracted) {
            jsonStr = extracted;
          } else {
            const regexMatch = jsonStr.match(/\{[\s\S]*"steps"[\s\S]*\}/) ?? jsonStr.match(/\{[\s\S]*\}/);
            if (!regexMatch) {
              emitEvent(controller, encoder, createAgentEvent('status', 'Error: LLM did not return valid JSON'));
              controller.close();
              return;
            }
            jsonStr = regexMatch[0];
          }
        }
        // Remove trailing commas before ] or } (invalid in JSON, some LLMs emit them)
        jsonStr = jsonStr.replace(/,(\s*[}\]])/g, "$1");

        if (jsonStr.includes("'") && !jsonStr.includes('"')) {
          try {
            jsonStr = jsonStr
              .replace(/'/g, '"')
              .replace(/True/g, "true")
              .replace(/False/g, "false")
              .replace(/None/g, "null");
          } catch {
            // Continue
          }
        }

        let plan: AgentPlan;
        try {
          plan = JSON.parse(jsonStr) as AgentPlan;
        } catch (parseError) {
          console.error("Plan JSON parse error:", parseError);
          console.error("Raw JSON string (first 500 chars):", jsonStr.slice(0, 500));
          emitEvent(controller, encoder, createAgentEvent('status', `Error: Failed to parse JSON plan. The model may have returned invalid JSON.`));
          // Try to extract error details
          const errorDetail = parseError instanceof Error ? parseError.message : String(parseError);
          emitEvent(controller, encoder, createAgentEvent('reasoning', `Parse error: ${errorDetail}`));
          controller.close();
          return;
        }

        if (!plan || !Array.isArray(plan.steps)) {
          console.error("Invalid plan structure:", plan);
          emitEvent(controller, encoder, createAgentEvent('status', 'Error: Invalid plan (missing steps array)'));
          if (plan && typeof plan === 'object') {
            emitEvent(controller, encoder, createAgentEvent('reasoning', `Plan object keys: ${Object.keys(plan).join(', ')}`));
          }
          controller.close();
          return;
        }

        if (plan.steps.length === 0) {
          console.error("Empty steps array in plan");
          console.error("Raw response (first 1000 chars):", raw.slice(0, 1000));
          console.error("Parsed plan:", JSON.stringify(plan, null, 2));
          emitEvent(controller, encoder, createAgentEvent('status', 'Error: Plan has no steps. The model may need more context or clearer instructions.'));
          emitEvent(controller, encoder, createAgentEvent('reasoning', 'The model returned a plan but with no steps. This might happen if:'));
          emitEvent(controller, encoder, createAgentEvent('reasoning', '1. Files mentioned in errors were not found in the workspace'));
          emitEvent(controller, encoder, createAgentEvent('reasoning', '2. The error logs are unclear or incomplete'));
          emitEvent(controller, encoder, createAgentEvent('reasoning', '3. The model needs more specific instructions'));
          emitEvent(controller, encoder, createAgentEvent('reasoning', 'Try: Including file paths in your error description, or asking to "fix the error in [filename]"'));
          controller.close();
          return;
        }

        emitEvent(controller, encoder, createAgentEvent('reasoning', `Plan generated: ${plan.steps.length} step(s)`));

        // Emit final result
        emitEvent(controller, encoder, createAgentEvent('status', 'Planning complete', {
          stepCount: plan.steps.length,
        }));

        // Send the plan as a final event
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'plan', plan, usage })}\n\n`));
        controller.close();
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : "Planning failed";
        emitEvent(controller, encoder, createAgentEvent('status', `Error: ${errorMsg}`));
        controller.close();
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
