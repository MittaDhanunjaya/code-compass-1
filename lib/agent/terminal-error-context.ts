import { classifyTerminalError, type ClassifiedTerminalError } from "./terminal-error-classifier";
import {
  classifyExecutionError,
  type StructuredExecutionError,
} from "./execution-error-classifier";

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

/** Format for agent repair prompt: constrain to stack traces/stderr paths, one-sentence explanation. */
export const SELF_HEAL_REPAIR_INSTRUCTIONS = `
CRITICAL: Only modify files mentioned in stack traces or stderr paths. Do not change unrelated code.
Explain the fix in exactly one sentence in the "reasoning" field.`;

/**
 * Build self-debug context from command result. Use this instead of ad-hoc (command, stdoutTail, stderrTail).
 * Pass the returned object to proposeFixSteps; it includes exitCode, errorClassification, and structuredError.
 */
export function buildSelfDebugContext(
  command: string,
  result: { exitCode?: number | null; stderr?: string | null; stdout?: string | null },
  tails: { stdoutTail: string; stderrTail: string }
): {
  command: string;
  stdoutTail: string;
  stderrTail: string;
  exitCode: number | null;
  errorClassification?: ClassifiedTerminalError;
  structuredError?: StructuredExecutionError;
} {
  const normalized = normalizeTerminalError(command, result);
  const errorClassification = classifyTerminalError(
    command,
    normalized.stderr,
    normalized.stdout,
    normalized.exitCode
  );
  const structuredError = classifyExecutionError(
    normalized.stderr,
    normalized.stdout,
    normalized.exitCode
  );
  return {
    command: normalized.command,
    stdoutTail: tails.stdoutTail,
    stderrTail: tails.stderrTail,
    exitCode: normalized.exitCode,
    errorClassification,
    structuredError,
  };
}
