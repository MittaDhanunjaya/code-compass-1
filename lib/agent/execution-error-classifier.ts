/**
 * Strongly-typed execution errors for repair prompt injection.
 * Replaces free-form error strings with structured fields.
 */

export type ExecutionErrorType =
  | "MODULE_NOT_FOUND"
  | "COMMAND_NOT_FOUND"
  | "SYNTAX_ERROR"
  | "PERMISSION_ERROR"
  | "CONFIG_ERROR"
  | "UNKNOWN";

export type StructuredExecutionError = {
  errorType: ExecutionErrorType;
  missingDependency?: string;
  failingFile?: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

const MODULE_PATTERNS = [
  /cannot find module ['"]([^'"]+)['"]/i,
  /module not found: ([^\s\n]+)/i,
  /MODULE_NOT_FOUND.*?['"]([^'"]+)['"]/i,
  /Error: Cannot find module ['"]([^'"]+)['"]/i,
  /No module named ['"]([^'"]+)['"]/i,
  /from ['"]([^'"]+)['"]/i,
];

const FILE_LINE_PATTERNS = [
  /at\s+([^\s:]+\.(?:ts|js|tsx|jsx|py|java))(?:\s*:\s*\d+)?/gi,
  /File\s+["']([^"']+)["']/gi,
  /in\s+([^\s:]+\.(?:py|ts|js))(?:\s*:\s*\d+)?/gi,
  /([a-zA-Z0-9_/-]+\.(?:ts|js|tsx|jsx|py))(?:\s*:\s*\d+)?/g,
];

function extractModuleName(stderr: string): string | undefined {
  for (const p of MODULE_PATTERNS) {
    const m = stderr.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

function extractFailingFile(stderr: string): string | undefined {
  for (const p of FILE_LINE_PATTERNS) {
    const m = p.exec(stderr);
    if (m && m[1]) {
      const path = m[1].trim().replace(/^\.\//, "").replace(/\\/g, "/");
      if (path && !path.startsWith("/")) return path;
    }
  }
  return undefined;
}

/**
 * Classify execution error into structured type.
 * Pass result into repair prompt for targeted fixes.
 */
export function classifyExecutionError(
  stderr: string,
  stdout: string,
  exitCode?: number | null
): StructuredExecutionError {
  const combined = `${stderr}\n${stdout}`.toLowerCase();

  if (exitCode === 127 || /command not found|'[^']+' is not recognized/i.test(combined)) {
    return {
      errorType: "COMMAND_NOT_FOUND",
      exitCode: exitCode ?? null,
      stderr,
      stdout,
    };
  }

  if (
    /cannot find module|module not found|MODULE_NOT_FOUND|no module named|npm ERR!|pnpm ERR!/i.test(
      combined
    )
  ) {
    return {
      errorType: "MODULE_NOT_FOUND",
      missingDependency: extractModuleName(stderr),
      failingFile: extractFailingFile(stderr),
      exitCode: exitCode ?? null,
      stderr,
      stdout,
    };
  }

  if (
    /syntax error|SyntaxError|unexpected token|invalid syntax|IndentationError|parse error/i.test(
      combined
    )
  ) {
    return {
      errorType: "SYNTAX_ERROR",
      failingFile: extractFailingFile(stderr),
      exitCode: exitCode ?? null,
      stderr,
      stdout,
    };
  }

  if (/EACCES|permission denied|EPERM|operation not permitted/i.test(combined)) {
    return {
      errorType: "PERMISSION_ERROR",
      exitCode: exitCode ?? null,
      stderr,
      stdout,
    };
  }

  if (
    /tsconfig|package\.json|go\.mod|jest\.config|vitest\.config|compilerOptions|paths.*not found/i.test(
      combined
    )
  ) {
    return {
      errorType: "CONFIG_ERROR",
      failingFile: extractFailingFile(stderr),
      exitCode: exitCode ?? null,
      stderr,
      stdout,
    };
  }

  return {
    errorType: "UNKNOWN",
    failingFile: extractFailingFile(stderr),
    exitCode: exitCode ?? null,
    stderr,
    stdout,
  };
}
