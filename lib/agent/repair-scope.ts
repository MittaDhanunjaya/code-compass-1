/**
 * Repair scope: extract allowed file paths from stack trace, stderr, command target.
 * Self-healing may ONLY modify files in this scope. Hard lock at runtime.
 */

/** Extract file paths from stack trace / stderr patterns. */
const STACK_PATTERNS = [
  /(?:File|file|at)\s+["']?([^\s"']+\.(?:py|js|ts|tsx|jsx|java|rb|go|rs|cpp|c|h|json|mod|sum))["']?\s*(?:,\s*line\s+\d+)?/gi,
  /(?:in|at)\s+([^\s"']+\.(?:py|js|ts|tsx|jsx|java|rb|go|rs|cpp|c|h))(?:\s*:\s*\d+)?/gi,
  /Traceback[\s\S]*?File\s+["']([^"']+)["']/gi,
  /Error.*?([^\s"']+\.(?:py|js|ts|tsx|jsx|json))(?:\s*:\s*\d+)?/gi,
  /([a-zA-Z0-9_/-]+\.(?:tsconfig|package)\.json)/gi,
  /([a-zA-Z0-9_/-]+\/go\.mod)/gi,
];

/** Extract target path from command (e.g. "npm run test" -> test file, "python app.py" -> app.py). */
function extractCommandTargetPath(command: string): string | null {
  const trimmed = command.trim();
  const pyMatch = trimmed.match(/\bpython(3)?\s+([^\s&|;]+\.py)/i);
  if (pyMatch) return pyMatch[2].trim();
  const nodeMatch = trimmed.match(/\bnode\s+([^\s&|;]+\.(?:js|ts))/i);
  if (nodeMatch) return nodeMatch[1].trim();
  const goMatch = trimmed.match(/\bgo\s+(?:run|test)\s+([^\s&|;]+)/i);
  if (goMatch) return goMatch[1].trim();
  return null;
}

/** Optional structured error with failingFile for scope expansion. */
export type RepairScopeOptions = {
  /** When stderr does not include file paths, add failingFile explicitly to scope. */
  failingFile?: string;
};

/**
 * Build repair scope: files mentioned in stack trace, stderr paths, command target, or failingFile.
 * Normalize paths (trim, collapse ./).
 */
export function buildRepairScope(
  command: string,
  stderr: string,
  stdout: string,
  options?: RepairScopeOptions
): Set<string> {
  const scope = new Set<string>();
  const combined = `${stderr}\n${stdout}`;

  for (const pattern of STACK_PATTERNS) {
    let m;
    while ((m = pattern.exec(combined)) !== null) {
      const path = (m[1] || m[2] || "").trim().replace(/^\.\//, "").replace(/\\/g, "/");
      if (path && path.length > 0 && !path.startsWith("/")) {
        scope.add(path);
      }
    }
  }

  const cmdTarget = extractCommandTargetPath(command);
  if (cmdTarget) {
    scope.add(cmdTarget.replace(/^\.\//, "").replace(/\\/g, "/"));
  }

  if (options?.failingFile?.trim()) {
    const normalized = options.failingFile.trim().replace(/^\.\//, "").replace(/\\/g, "/");
    if (normalized && !normalized.startsWith("/")) {
      scope.add(normalized);
    }
  }

  return scope;
}

/**
 * Check if a path is in repair scope. Uses prefix match for nested paths
 * (e.g. scope has "src/app.ts", path "src/app.ts" is allowed).
 */
export function isPathInRepairScope(path: string, scope: Set<string>): boolean {
  const normalized = path.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (scope.has(normalized)) return true;
  for (const s of scope) {
    if (normalized === s || normalized.endsWith("/" + s) || s.endsWith("/" + normalized)) return true;
  }
  return false;
}
