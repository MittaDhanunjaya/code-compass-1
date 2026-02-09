import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import type { FileEditStep } from "@/lib/agent/types";
import type { ComposerPlan, ComposerScope } from "@/lib/composer/types";
import type { SearchResult } from "@/lib/indexing/types";
import { resolveWorkspaceId } from "@/lib/workspaces/active-workspace";
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

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    workspaceId?: string;
    instruction?: string;
    scope?: ComposerScope;
    currentFilePath?: string | null;
    provider?: ProviderId;
    model?: string;
    fileContents?: Record<string, string>;
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
  const scope = (body.scope ?? "current_file") as ComposerScope;
  const currentFilePath = body.currentFilePath?.trim() ?? null;

  const workspaceId = await resolveWorkspaceId(supabase, user.id, body.workspaceId);
  if (!workspaceId || !instruction) {
    return NextResponse.json(
      { error: workspaceId ? "instruction is required" : "No active workspace selected" },
      { status: 400 }
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // Fetch all workspace file paths (and content for candidate set)
  const { data: allFiles, error: listError } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .order("path", { ascending: true });

  if (listError) {
    return NextResponse.json(
      { error: listError.message },
      { status: 500 }
    );
  }

  const paths = (allFiles ?? []).map((r) => r.path);
  let candidatePaths: string[] = [];

  if (scope === "current_file") {
    if (!currentFilePath) {
      return NextResponse.json(
        { error: "currentFilePath is required for scope 'current_file'" },
        { status: 400 }
      );
    }
    if (!paths.includes(currentFilePath)) {
      return NextResponse.json(
        { error: "Current file is not in workspace" },
        { status: 400 }
      );
    }
    candidatePaths = [currentFilePath];
  } else if (scope === "current_folder") {
    if (!currentFilePath) {
      return NextResponse.json(
        { error: "currentFilePath is required for scope 'current_folder'" },
        { status: 400 }
      );
    }
    const dir = getDir(currentFilePath);
    candidatePaths = paths.filter((p) => p === currentFilePath || p.startsWith(dir));
    if (candidatePaths.length > WORKSPACE_FILE_CAP) {
      candidatePaths = candidatePaths.slice(0, WORKSPACE_FILE_CAP);
    }
  } else {
    // workspace: cap at WORKSPACE_FILE_CAP
    candidatePaths = paths.slice(0, WORKSPACE_FILE_CAP);
  }

  if (candidatePaths.length === 0) {
    return NextResponse.json(
      { error: "No candidate files in scope" },
      { status: 400 }
    );
  }

  // Optional: use index for context (same as Agent)
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
      // ignore index errors
    }
  }

  // Build file contents for candidate paths: prefer frontend (editor) content, else DB
  const fileContents: Record<string, string> = {};
  const filesMeta = allFiles ?? [];
  const fromFrontend = body.fileContents ?? {};
  for (const path of candidatePaths) {
    if (fromFrontend[path] !== undefined) {
      fileContents[path] = fromFrontend[path].slice(0, 8000);
    } else {
      const row = filesMeta.find((r) => r.path === path);
      if (row) {
        fileContents[path] = (row.content ?? "").slice(0, 8000);
      }
    }
  }

  const requestedProvider = (body.provider ?? "openrouter") as ProviderId;
  const providersToTry = PROVIDERS.includes(requestedProvider)
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let apiKey: string | null = null;
  let providerId: ProviderId | null = null;
  const triedProviders: ProviderId[] = [];
  
  for (const p of providersToTry) {
    triedProviders.push(p);
    const { data: keyRow, error: keyError } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", user.id)
      .eq("provider", p)
      .maybeSingle(); // Use maybeSingle() instead of single() to avoid throwing on no rows
    
    if (keyError) {
      console.error(`Error fetching key for ${p}:`, keyError);
      continue;
    }
    
    if (keyRow?.key_encrypted) {
      try {
        apiKey = decrypt(keyRow.key_encrypted);
        providerId = p;
        break;
      } catch (decryptError) {
        console.error(`Error decrypting key for ${p}:`, decryptError);
        continue;
      }
    }
  }

  if (!apiKey || !providerId) {
    const triedLabels = triedProviders.map(p => PROVIDER_LABELS[p]).join(", ");
    const freeOptions = "OpenRouter (free models available) or Gemini (free tier)";
    return NextResponse.json(
      {
        error:
          `No API key configured for any provider. Tried: ${triedLabels}. ` +
          `Add an API key in Settings → API Keys. Recommended: ${freeOptions}. ` +
          `Get free keys at: OpenRouter (https://openrouter.ai/keys) or Gemini (https://aistudio.google.com/apikey)`,
      },
      { status: 400 }
    );
  }

  let userContent = `Instruction: ${instruction}\n\nCandidate file paths (you may only edit these):\n${candidatePaths.join("\n")}`;
  if (indexedFiles.length > 0) {
    userContent += "\n\nRelevant codebase context (from index):\n";
    for (const result of indexedFiles) {
      userContent += `\n--- ${result.path}${result.line ? ` (line ${result.line})` : ""} ---\n${result.preview}\n`;
    }
  }
  if (Object.keys(fileContents).length > 0) {
    userContent += "\n\nFile contents (path -> content):\n";
    for (const [path, content] of Object.entries(fileContents)) {
      userContent += `\n--- ${path} ---\n${content}\n`;
    }
  }

  // Load project rules
  const rules = await loadRules(supabase, workspaceId);
  const rulesPrompt = formatRulesForPrompt(rules);
  const systemPromptWithRules = COMPOSER_SYSTEM + rulesPrompt;

  try {
    const provider = getProvider(providerId);
    const modelOpt = getModelForProvider(providerId, body.model);
    const { content: raw, usage } = await provider.chat(
      [
        { role: "system", content: systemPromptWithRules },
        { role: "user", content: userContent },
      ],
      apiKey,
      { model: modelOpt }
    );

    const trimmed = raw.trim();
    const parseResult = parseJSONRobust<ComposerPlan>(trimmed, ["steps"]);
    if (!parseResult.success || !parseResult.data) {
      return NextResponse.json(
        {
          error: `Failed to parse JSON: ${parseResult.error ?? "Unknown"}. Raw preview: ${(parseResult.raw ?? trimmed).slice(0, 500)}`,
        },
        { status: 500 }
      );
    }
    const plan = parseResult.data;

    if (!plan || !Array.isArray(plan.steps)) {
      return NextResponse.json(
        { error: "LLM did not return a valid plan (missing steps array)" },
        { status: 500 }
      );
    }

    // Filter to file_edit only and ensure path is in candidate set; attach originalContent for diff UI
    const fileEditSteps: FileEditStep[] = [];
    const stepsWithContent: { path: string; originalContent: string; newContent: string; oldContent?: string; description?: string }[] = [];
    for (const step of plan.steps) {
      if (step.type === "file_edit" && step.path && typeof step.newContent === "string") {
        if (candidatePaths.includes(step.path)) {
          fileEditSteps.push(step);
          const original = fileContents[step.path] ?? "";
          stepsWithContent.push({
            path: step.path,
            originalContent: original,
            newContent: step.newContent,
            oldContent: step.oldContent,
            description: step.description,
          });
        }
      }
    }

    return NextResponse.json({
      plan: { steps: fileEditSteps, summary: plan.summary },
      stepsWithContent,
      provider: providerId,
      usage,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Composer plan failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
