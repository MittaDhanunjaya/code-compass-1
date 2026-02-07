/**
 * Lightweight error-log detection for routing chat/agent messages.
 * Uses pattern matching only (no LLM). Tune THRESHOLD or pattern weights to adjust sensitivity.
 */

export type ErrorLogKind = "normal" | "error_log";

// Compiled patterns for JS/TS/Next/Node
const JS_ERROR_PATTERNS = [
  /\bError:\s*\S/i,
  /\bTypeError:\s*\S/i,
  /\bReferenceError:\s*\S/i,
  /\bSyntaxError:\s*\S/i,
  /\bRangeError:\s*\S/i,
  /\bUnhandledPromiseRejection\b/i,
  /\bUnhandled\s+Runtime\s+Error\b/i,
  /\bUncaught\s+\S+/i,
  /\bNextRouter\s+error\b/i,
  /\bHydration\s+failed\b/i,
  /TypeError\s+at\s+\/\S+/i,
];

// Stack trace lines
const STACK_TRACE_PATTERNS = [
  /\bat\s+[\w.$]+\s*\([^)]*:\d+(:\d+)?\)/,
  /\bat\s+[\w.$]+\s*\([^)]+\.(ts|tsx|js|jsx|mjs)\s*:\s*\d+/i,
  /^\s*at\s+\S+/m,
  /\bat\s+\/\S+\s+\(/,
  /\b(line|:\s*)\d+(:\d+)?\b/,
];

// HTTP error templates
const HTTP_ERROR_PATTERNS = [
  /\b500\s+Internal\s+Server\s+Error\b/i,
  /\b4\d{2}\s+(?:Bad\s+Request|Not\s+Found|Forbidden|Unauthorized)\b/i,
  /\bGET\s+\/api\/\S+\s+\d{3}\b/i,
  /\bPOST\s+\/api\/\S+\s+\d{3}\b/i,
  /\b\d{3}\s+[\w\s]+\s*$/m,
];

// Python-style traces
const PYTHON_TRACE_PATTERNS = [
  /\bTraceback\s+\(most\s+recent\s+call\s+last\)\s*:/i,
  /File\s+["'][^"']+["']\s*,\s*line\s+\d+/i,
];

// Minimum length to avoid short conversational "Error: ok" style messages
const MIN_LENGTH = 80;
// Score threshold: need at least this many points to classify as error_log
const THRESHOLD = 2;

/** Count how many of the patterns match the text (each pattern at most once). */
function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter((r) => r.test(text)).length;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((r) => r.test(text));
}

/**
 * Detects whether the message looks like runtime logs / stack traces.
 * Returns "error_log" when patterns are strong enough; "normal" otherwise.
 * Uses a simple score so we can tune THRESHOLD later.
 */
export function detectErrorLogKind(message: string): ErrorLogKind {
  const trimmed = message.trim();
  if (trimmed.length < MIN_LENGTH) return "normal";

  let score = 0;

  // Strong signals (each worth 2)
  if (hasAny(trimmed, PYTHON_TRACE_PATTERNS)) score += 2;
  if (hasAny(trimmed, JS_ERROR_PATTERNS)) score += 2;
  if (hasAny(trimmed, HTTP_ERROR_PATTERNS)) score += 2;

  // Stack frames (number of distinct pattern types that match)
  const stackMatches = countPatternMatches(trimmed, STACK_TRACE_PATTERNS);
  if (stackMatches >= 2) score += 2;
  else if (stackMatches === 1) score += 1;

  // Multiple lines often indicate a paste
  const lineCount = trimmed.split(/\r?\n/).length;
  if (lineCount >= 5 && score >= 1) score += 1;
  if (lineCount >= 10) score += 1;

  return score >= THRESHOLD ? "error_log" : "normal";
}
