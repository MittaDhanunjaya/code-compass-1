/**
 * Enhanced self-debug: propose file edits to fix failing commands.
 * Uses LLM with command output + edited files as context. Supports multiple retry attempts.
 */

import { getProvider, type ProviderId } from "@/lib/llm/providers";
import type { FileEditStep } from "@/lib/agent/types";
import { extractPortFromError, findAvailablePort } from "./port-utils";

const SELF_DEBUG_SYSTEM = `You are an intelligent coding assistant helping to fix a failed command. Analyze the error, understand the codebase structure, and propose targeted fixes.

CRITICAL: Output valid JSON only. No markdown, no explanation outside the JSON. Use double quotes for all strings.

Output a single JSON object with this exact shape:
{
  "steps": [
    { "type": "file_edit", "path": "<relative path>", "oldContent": "<exact snippet to replace or omit>", "newContent": "<new content>", "description": "<optional>" }
  ],
  "reasoning": "<brief explanation of what you're fixing>"
}

Your approach:
1. **Understand the error**: Read the error message carefully. What is it telling you? What went wrong and why?
2. **Understand the codebase**: Look at the workspace files provided. How is the project structured? Where are configurations? Where is the code that's failing?
3. **Find the root cause**: Don't just fix symptoms. Understand why the error occurred. Is it a configuration issue? A code bug? A missing dependency? A port conflict? An environment issue?
4. **Propose targeted fixes**: Make minimal, precise changes that address the root cause. Fix all related locations if needed.
5. **Learn from failures**: If previous attempts failed, analyze why. What did you miss? What assumption was wrong?

Guidelines:
- path must be relative to workspace root.
- Include oldContent only when replacing a specific snippet; omit for full file replace.
- Propose at most 3-5 file_edit steps. Be targeted; only fix what the failure suggests.
- Think through the problem systematically. Don't guess - use the information provided.
- If you cannot suggest a fix, return { "steps": [], "reasoning": "Unable to determine fix" }.
- Output ONLY the JSON object.`;

const LAST_LINES = 150; // Increased for better context
const _MAX_RETRY_ATTEMPTS = 5; // Maximum number of self-debug attempts

export type SelfDebugContext = {
  command: string;
  stdoutTail: string;
  stderrTail: string;
  filesEdited: string[];
  workspaceFiles?: string[]; // List of workspace file paths for context
  fileContents?: Record<string, string>; // File contents for relevant files (e.g., server files for port conflicts)
  previousAttempts?: Array<{
    attempt: number;
    steps: FileEditStep[];
    result: { status: string; summary: string };
  }>;
};

export type SelfDebugOptions = {
  apiKey: string;
  providerId: ProviderId;
  model?: string;
};

/**
 * Propose file_edit steps to fix a failing command. Returns empty array if no fix or parse error.
 * Enhanced with support for multiple retry attempts.
 */
export async function proposeFixSteps(
  context: SelfDebugContext,
  options: SelfDebugOptions
): Promise<FileEditStep[]> {
  const { command, stdoutTail, stderrTail, filesEdited, workspaceFiles, fileContents, previousAttempts } = context;
  
  const userContentParts = [
    `Failed command: ${command}`,
    "",
    "stdout (last lines):",
    stdoutTail || "(empty)",
    "",
    "stderr (last lines):",
    stderrTail || "(empty)",
    "",
    "Files edited in this run:",
    filesEdited.length ? filesEdited.join("\n") : "(none)",
  ];
  
  // Check for port conflicts and provide helpful context (but let LLM reason about it)
  const combinedOutput = `${stdoutTail}\n${stderrTail}`;
  const conflictedPort = extractPortFromError(combinedOutput);
  
  if (conflictedPort) {
    // Find an available port to suggest, but let LLM figure out how to use it
    const availablePort = await findAvailablePort(conflictedPort + 1, 20);
    if (availablePort) {
      userContentParts.push(
        "",
        `Note: Port ${conflictedPort} appears to be in use. Port ${availablePort} appears to be available.`
      );
    }
  }

  // Add workspace file list if available (helps find config files)
  if (workspaceFiles && workspaceFiles.length > 0) {
    userContentParts.push("", "Workspace files (for reference):");
    // Filter to show likely config/server files first
    const serverFiles = workspaceFiles.filter(f => 
      /(server|app|main|index|config)\.(js|ts|jsx|tsx|py|json)$/i.test(f) ||
      /package\.json|\.env|vite\.config|next\.config/i.test(f)
    );
    const otherFiles = workspaceFiles.filter(f => !serverFiles.includes(f));
    if (serverFiles.length > 0) {
      userContentParts.push("Likely config/server files:", serverFiles.slice(0, 20).join("\n"));
    }
    if (otherFiles.length > 0 && otherFiles.length <= 50) {
      userContentParts.push("Other files:", otherFiles.slice(0, 30).join("\n"));
    }
  }

  // Add file contents if available (especially useful for port conflicts)
  if (fileContents && Object.keys(fileContents).length > 0) {
    userContentParts.push("", "Relevant file contents:");
    for (const [path, content] of Object.entries(fileContents)) {
      userContentParts.push(`\n--- ${path} ---\n${content.slice(0, 2000)}\n`);
    }
  }

  // Add previous attempts context if available
  if (previousAttempts && previousAttempts.length > 0) {
    userContentParts.push("", "Previous fix attempts:");
    for (const attempt of previousAttempts) {
      userContentParts.push(
        `Attempt ${attempt.attempt}: Applied ${attempt.steps.length} edit(s), result: ${attempt.result.status} (${attempt.result.summary})`
      );
    }
    userContentParts.push("", "Analyze why previous attempts failed and try a different approach.");
  }

  const userContent = userContentParts.join("\n");

  const provider = getProvider(options.providerId);
  const { content: raw } = await provider.chat(
    [
      { role: "system", content: SELF_DEBUG_SYSTEM },
      { role: "user", content: userContent },
    ],
    options.apiKey,
    { model: options.model }
  );

  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let jsonStr = jsonMatch[0];
  if (jsonStr.includes("'") && !jsonStr.includes('"')) {
    jsonStr = jsonStr
      .replace(/'/g, '"')
      .replace(/True/g, "true")
      .replace(/False/g, "false")
      .replace(/None/g, "null");
  }

  try {
    const parsed = JSON.parse(jsonStr) as { steps?: unknown[] };
    if (!parsed?.steps || !Array.isArray(parsed.steps)) return [];

    const steps: FileEditStep[] = [];
    for (const s of parsed.steps) {
      if (
        s &&
        typeof s === "object" &&
        (s as { type?: string }).type === "file_edit" &&
        typeof (s as { path?: string }).path === "string" &&
        typeof (s as { newContent?: string }).newContent === "string"
      ) {
        const step = s as { path: string; newContent: string; oldContent?: string; description?: string };
        steps.push({
          type: "file_edit",
          path: step.path,
          newContent: step.newContent,
          oldContent: step.oldContent,
          description: step.description,
        });
      }
    }
    return steps;
  } catch {
    return [];
  }
}

/** Take last N lines from a string. */
export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

/** Build stdout/stderr tails for self-debug context. */
export function buildTails(stdout: string, stderr: string, maxLines: number = LAST_LINES): { stdoutTail: string; stderrTail: string } {
  return {
    stdoutTail: lastLines(stdout, maxLines),
    stderrTail: lastLines(stderr, maxLines),
  };
}
