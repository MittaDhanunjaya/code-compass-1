/**
 * Self-Healing Error Context: normalize terminal/command errors into a structured object.
 * Passed into the agent repair prompt for targeted fixes.
 */

export type TerminalErrorContext = {
  command: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

/**
 * Normalize command result into structured error context for agent repair.
 */
export function normalizeTerminalError(
  command: string,
  result: { exitCode?: number | null; stderr?: string | null; stdout?: string | null }
): TerminalErrorContext {
  return {
    command,
    exitCode: result.exitCode ?? null,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

/** Format for agent repair prompt: instruct minimal edits and one-sentence explanation. */
export const SELF_HEAL_REPAIR_INSTRUCTIONS = `
CRITICAL: Only modify files directly related to this error. Do not change unrelated code.
Explain the fix in one sentence in the "reasoning" field.`;
