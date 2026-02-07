/**
 * v1 self-debug: propose file edits to fix a failing test command.
 * Uses LLM with command output + edited files as context. One attempt per test failure.
 */

import { getProvider, type ProviderId } from "@/lib/llm/providers";
import type { FileEditStep } from "@/lib/agent/types";

const SELF_DEBUG_SYSTEM = `You are a coding assistant. A test command failed. Given the command, the last lines of stdout/stderr, and the list of files the agent edited so far, propose a SMALL set of targeted file_edit steps to fix the failure.

CRITICAL: Output valid JSON only. No markdown, no explanation outside the JSON. Use double quotes for all strings.

Output a single JSON object with this exact shape:
{
  "steps": [
    { "type": "file_edit", "path": "<relative path>", "oldContent": "<exact snippet to replace or omit>", "newContent": "<new content>", "description": "<optional>" }
  ]
}

Rules:
- path must be relative to workspace root.
- Include oldContent only when replacing a specific snippet; omit for full file replace.
- Propose at most 3-5 file_edit steps. Be targeted; only fix what the failure suggests.
- If you cannot suggest a fix, return { "steps": [] }.
- Output ONLY the JSON object.`;

const LAST_LINES = 80;

export type SelfDebugContext = {
  command: string;
  stdoutTail: string;
  stderrTail: string;
  filesEdited: string[];
};

export type SelfDebugOptions = {
  apiKey: string;
  providerId: ProviderId;
  model?: string;
};

/**
 * Propose file_edit steps to fix a failing test. Returns empty array if no fix or parse error.
 */
export async function proposeFixSteps(
  context: SelfDebugContext,
  options: SelfDebugOptions
): Promise<FileEditStep[]> {
  const { command, stdoutTail, stderrTail, filesEdited } = context;
  const userContent = [
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
  ].join("\n");

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
