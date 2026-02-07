/**
 * Classifies a chat message as error-log vs normal.
 * Used to route pasted logs to the debug-from-log flow when the user confirms.
 */

export type MessageKind = "error_log" | "normal";

const TRACEBACK_MARKERS = [
  "Traceback (most recent call last):",
  "traceback (most recent call last):",
];

const EXCEPTION_MARKERS = [
  "Exception in thread",
  "Error:",
  "Exception:",
  "SyntaxError:",
  "ReferenceError:",
  "RuntimeError:",
  "ValueError:",
  "KeyError:",
  "IndexError:",
  "AttributeError:",
  "ImportError:",
  "ModuleNotFoundError:",
  "UnhandledPromiseRejection",
  "Uncaught ",
  "TypeError:",
  "TypeError at ",
];

/** Stack frame pattern: "at Class.method (file:line)" or "File \"path\", line N" or "at /route" */
const STACK_FRAME_PATTERNS = [
  /\bat\s+\S+\s+\([^)]*:\s*\d+/i,
  /File\s+["'][^"']+["']\s*,\s*line\s+\d+/i,
  /\s+at\s+(\S+\.\w+)\s*\(/,
  /^\s*#\d+\s+.+\.(py|js|ts|tsx|jsx|java|go|rs)\s*:\s*\d+/m,
  /\b(line|:\s*)\d+(:\d+)?\b/i,
  /TypeError\s+at\s+\/\S+/i,
  /at\s+\/\S+\s+\(/i,
];

/** Minimum length to consider (avoid short "Error: ok" type messages). */
const MIN_LENGTH_FOR_ERROR_LOG = 80;

export function classifyMessage(content: string): MessageKind {
  const trimmed = content.trim();
  if (trimmed.length < MIN_LENGTH_FOR_ERROR_LOG) return "normal";

  const lower = trimmed.toLowerCase();

  const hasTraceback = TRACEBACK_MARKERS.some((m) => trimmed.includes(m) || lower.includes(m.toLowerCase()));
  if (hasTraceback) return "error_log";

  const hasException = EXCEPTION_MARKERS.some((m) => trimmed.includes(m) || lower.includes(m));
  const hasStackFrame = STACK_FRAME_PATTERNS.some((r) => r.test(trimmed));
  if (hasException && hasStackFrame) return "error_log";

  if (hasTraceback || (hasException && trimmed.split("\n").length >= 3)) return "error_log";

  return "normal";
}
