import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, CommandStep, PlanStep } from "@/lib/agent/types";
import type { SearchResult } from "@/lib/indexing/types";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";

const VENV_COMMAND = "python3 -m venv venv";

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

RUN INSTRUCTIONS (MANDATORY): Every plan MUST include at least one file that documents how to run the app or complete the task: README.md (with "How to run" / "Usage" section) or HOW_TO_RUN.txt. The content must be concrete steps (e.g. "1. Create venv: python3 -m venv venv 2. Install: venv/bin/pip install -r requirements.txt 3. Run: venv/bin/python main.py").`;

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
    model?: string; // Model selection (for OpenRouter)
    fileList?: string[];
    fileContents?: Record<string, string>;
    useIndex?: boolean; // If true, search index for relevant files
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

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const providersToTry = PROVIDERS.includes(requestedProvider)
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let apiKey: string | null = null;
  let providerId: ProviderId | null = null;
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
    return NextResponse.json(
      {
        error:
          `No API key configured for ${requestedLabel}. Add one in API Key settings.`,
      },
      { status: 400 }
    );
  }

  let userContent = `Instruction: ${instruction}`;
  
  // If useIndex is true, search the index for relevant files
  let indexedFiles: SearchResult[] = [];
  if (body.useIndex && workspaceId) {
    try {
      // Extract key terms from instruction for search
      const searchTerms = instruction
        .split(/\s+/)
        .filter((w) => w.length > 3 && !/^(the|and|or|for|with|from)$/i.test(w))
        .slice(0, 3)
        .join(" ");
      
      if (searchTerms) {
        // Internal search - query database directly
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
    } catch (e) {
      // Index search failed, continue without it
      console.error("Index search failed:", e);
    }
  }

  if (body.fileList?.length) {
    userContent += `\n\nFiles in workspace (paths):\n${body.fileList.join("\n")}`;
  }
  
  // Add indexed search results if available
  if (indexedFiles.length > 0) {
    userContent += "\n\nRelevant codebase context (from index):\n";
    for (const result of indexedFiles) {
      userContent += `\n--- ${result.path}${result.line ? ` (line ${result.line})` : ""} ---\n${result.preview}\n`;
    }
  }
  
  if (body.fileContents && Object.keys(body.fileContents).length > 0) {
    userContent += "\n\nRelevant file contents (path -> content):\n";
    for (const [path, content] of Object.entries(body.fileContents)) {
      userContent += `\n--- ${path} ---\n${content.slice(0, 8000)}\n`;
    }
  }

  try {
    const provider = getProvider(providerId);
    const modelOpt = getModelForProvider(providerId, body.model);
    const { content: raw, usage } = await provider.chat(
      [
        { role: "system", content: PLAN_SYSTEM },
        { role: "user", content: userContent },
      ],
      apiKey,
      { model: modelOpt }
    );

    // Detect if response is clearly not JSON (CSS, code, etc.)
    const trimmed = raw.trim();
    if (
      trimmed.startsWith("{") === false &&
      trimmed.startsWith("[") === false &&
      !trimmed.includes('"steps"') &&
      !trimmed.includes("'steps'")
    ) {
      // Check for common non-JSON patterns
      if (
        trimmed.includes("margin:") ||
        trimmed.includes("font-family:") ||
        trimmed.includes("def ") ||
        trimmed.includes("function ") ||
        trimmed.includes("import ") ||
        trimmed.includes("const ") ||
        trimmed.includes("class ")
      ) {
        return NextResponse.json(
          {
            error: `LLM returned code instead of JSON plan. Please rephrase your instruction to be a clear task request (e.g., "Create a file X with content Y" or "Add feature Z"). Raw response preview: ${trimmed.slice(0, 150)}`,
          },
          { status: 500 }
        );
      }
    }

    // Extract JSON from markdown code blocks or plain JSON
    let jsonStr = trimmed;
    // Remove markdown code block markers if present
    jsonStr = jsonStr.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/g, "");
    // Find the first complete JSON object
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json(
        {
          error: `LLM did not return valid JSON. The response should be a JSON object with a "steps" array. Raw response preview: ${raw.slice(0, 200)}`,
        },
        { status: 500 }
      );
    }
    jsonStr = jsonMatch[0];

    // Try to convert Python dict syntax to JSON (fallback)
    if (jsonStr.includes("'") && !jsonStr.includes('"')) {
      try {
        jsonStr = jsonStr
          .replace(/'/g, '"')
          .replace(/True/g, "true")
          .replace(/False/g, "false")
          .replace(/None/g, "null");
      } catch {
        // Continue to try parsing
      }
    }

    let plan: AgentPlan;
    try {
      plan = JSON.parse(jsonStr) as AgentPlan;
    } catch (parseError) {
      return NextResponse.json(
        {
          error: `Failed to parse JSON: ${parseError instanceof Error ? parseError.message : "Unknown error"}. The LLM should return a JSON plan with "steps" array. Raw preview: ${jsonStr.slice(0, 300)}`,
        },
        { status: 500 }
      );
    }

    if (!plan || !Array.isArray(plan.steps)) {
      return NextResponse.json(
        { error: "LLM did not return a valid plan (missing steps array)" },
        { status: 500 }
      );
    }

    for (const step of plan.steps) {
      if (step.type === "file_edit") {
        if (!step.path || typeof step.newContent !== "string") {
          return NextResponse.json(
            { error: "Invalid file_edit step: path and newContent required" },
            { status: 500 }
          );
        }
      } else if (step.type === "command") {
        if (!step.command || typeof step.command !== "string") {
          return NextResponse.json(
            { error: "Invalid command step: command required" },
            { status: 500 }
          );
        }
      }
    }

    // Ensure Python projects always have a venv creation step
    ensurePythonVenvStep(plan);

    return NextResponse.json({ plan, provider: providerId, usage });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Plan generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
