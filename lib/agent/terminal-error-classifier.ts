/**
 * Classify terminal/command errors for repair prompt injection.
 * Types: DEPENDENCY_ERROR, SYNTAX_ERROR, CONFIG_ERROR, RUNTIME_ERROR, PERMISSION_ERROR
 */

export type TerminalErrorType =
  | "DEPENDENCY_ERROR"
  | "SYNTAX_ERROR"
  | "CONFIG_ERROR"
  | "RUNTIME_ERROR"
  | "PERMISSION_ERROR"
  | "UNKNOWN";

export type ClassifiedTerminalError = {
  type: TerminalErrorType;
  hint: string;
};

/** Patterns for dependency errors (npm, pip, go mod, etc.) */
const DEPENDENCY_PATTERNS = [
  /cannot find module|module not found|MODULE_NOT_FOUND/i,
  /npm ERR!|pnpm ERR!|yarn error/i,
  /pip.*(?:no matching|could not find|error:.*package)/i,
  /go:.*cannot find|go:.*module .* not found/i,
  /require.*is not defined|is not a function/i,
  /dependency.*not found|package.*not found/i,
  /E404|ENOENT.*node_modules/i,
  /npm install|pip install|go get/i,
];

/** Patterns for syntax errors */
const SYNTAX_PATTERNS = [
  /syntax error|SyntaxError|unexpected token/i,
  /unexpected end of file|unexpected EOF/i,
  /invalid syntax|IndentationError/i,
  /expected.*but got|expected ';'|expected '\)'/i,
  /parsing error|parse error/i,
];

/** Patterns for config errors (tsconfig, package.json, go.mod, etc.) */
const CONFIG_PATTERNS = [
  /tsconfig|tsconfig\.json|compilerOptions/i,
  /package\.json|scripts|module not found/i,
  /go\.mod|go\.sum|replace directive/i,
  /cannot find module.*tsconfig|paths.*not found/i,
  /jest\.config|vitest\.config|vite\.config/i,
];

/** Patterns for permission errors */
const PERMISSION_PATTERNS = [
  /EACCES|permission denied|Permission denied/i,
  /EPERM|operation not permitted/i,
  /EADDRINUSE|address already in use/i,
  /root required|sudo required/i,
];

/** Patterns for runtime errors (general) */
const RUNTIME_PATTERNS = [
  /TypeError|ReferenceError|RangeError/i,
  /AssertionError|RuntimeError/i,
  /undefined is not|null is not/i,
  /port.*in use|address already in use/i,
  /ECONNREFUSED|ENOTFOUND/i,
];

export function classifyTerminalError(
  command: string,
  stderr: string,
  stdout: string,
  exitCode?: number | null
): ClassifiedTerminalError {
  const combined = `${command}\n${stderr}\n${stdout}`.toLowerCase();

  if (PERMISSION_PATTERNS.some((p) => p.test(combined))) {
    return { type: "PERMISSION_ERROR", hint: "This is a PERMISSION_ERROR. Check file permissions, ports, or run as appropriate user." };
  }

  if (DEPENDENCY_PATTERNS.some((p) => p.test(combined)) || exitCode === 127) {
    return { type: "DEPENDENCY_ERROR", hint: "This is a DEPENDENCY_ERROR. Do not change application logic. Only fix dependencies (npm install, pip install, go mod tidy, etc.)." };
  }

  if (SYNTAX_PATTERNS.some((p) => p.test(combined))) {
    return { type: "SYNTAX_ERROR", hint: "This is a SYNTAX_ERROR. Fix the syntax at the reported file:line. Do not change unrelated code." };
  }

  if (CONFIG_PATTERNS.some((p) => p.test(combined))) {
    return { type: "CONFIG_ERROR", hint: "This is a CONFIG_ERROR. Fix tsconfig.json, package.json, go.mod, or other config. Do not change application logic." };
  }

  if (RUNTIME_PATTERNS.some((p) => p.test(combined))) {
    return { type: "RUNTIME_ERROR", hint: "This is a RUNTIME_ERROR. Fix the code at the reported location. Minimal, surgical edits only." };
  }

  return { type: "UNKNOWN", hint: "Analyze the error and propose a minimal fix. Only modify files mentioned in stack traces or stderr." };
}
