/**
 * Utilities for detecting and handling pasted terminal/runtime logs.
 * Used to show compact chip and auto-invoke debug-from-log.
 */

import { classifyMessage } from "@/lib/error-log-classifier";

export type LogAttachment = {
  id: string;
  source?: string;
  lineCount: number;
  preview: string;
  fullText: string;
};

/** Check if pasted text looks like terminal/runtime logs (errors, stack traces, command output). */
export function looksLikeLog(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length < 3) return false;
  // Use existing classifier for error logs
  if (classifyMessage(trimmed) === "error_log") return true;
  // Also detect command-line output (prompt prefixes)
  const hasCommandLine = lines.some((l) => l.startsWith("$ ") || l.startsWith("> ") || l.startsWith("% "));
  const hasStackLine = lines.some(
    (l) =>
      l.includes("Error:") ||
      l.includes("Exception") ||
      l.match(/at\s+.*:\d+:\d+/) ||
      l.match(/File\s+["'][^"']+["']\s*,\s*line\s+\d+/)
  );
  return hasStackLine || (hasCommandLine && lines.length >= 5);
}

/** Detect log source from content (zsh, npm, node, etc.). */
export function detectLogSource(lines: string[]): string | undefined {
  const joined = lines.join("\n").toLowerCase();
  if (joined.includes("zsh") || joined.includes("bash")) return "zsh";
  if (joined.includes("npm ")) return "npm";
  if (joined.includes("node ") || joined.includes("node:")) return "node";
  if (joined.includes("python") || joined.includes("traceback")) return "python";
  if (joined.includes("go run") || joined.includes(".go:")) return "go";
  return undefined;
}

/** Create a LogAttachment from pasted text. */
export function createLogAttachment(text: string): LogAttachment {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return {
    id: crypto.randomUUID(),
    source: detectLogSource(lines),
    lineCount: lines.length,
    preview: lines.slice(0, 3).join("\n"),
    fullText: text,
  };
}
