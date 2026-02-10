/**
 * Protected file/path patterns the AI will not edit without extra confirmation (in Safe edit mode).
 * Simple glob-like matching: * = any chars in segment, ** = path prefix.
 */

/** In Safe edit mode, AI operations that would modify more than this many files require extra confirmation. */
export const SAFE_EDIT_MAX_FILES = 20;

/** Over-edit guardrail: if a single file_edit would replace more than this fraction of the file (by length), treat as over-edit and require confirmation or reject. */
export const OVER_EDIT_RATIO_THRESHOLD = 0.4;

export const DEFAULT_PROTECTED_PATTERNS = [
  ".env*",
  "*.key",
  "*.pem",
  "config/secrets/**",
  ".github/workflows/**",
  "infra/**",
] as const;

/** Patterns used for matching (defaults to DEFAULT_PROTECTED_PATTERNS). */
export type ProtectedPattern = string;

/**
 * Check if a file path matches any of the protected patterns.
 * Pattern rules:
 * - ".env*" matches .env, .env.local, .env.production, etc.
 * - "*.pem" matches any path ending in .pem (e.g. key.pem, certs/key.pem)
 * - ".github/workflows/**" matches .github/workflows/anything or .github/workflows/foo/bar
 * - "infra/**" matches infra/anything (path starts with infra/)
 */
export function isProtectedPath(
  path: string,
  patterns: readonly ProtectedPattern[] = DEFAULT_PROTECTED_PATTERNS
): boolean {
  const normalized = path.trim();
  if (!normalized) return false;

  for (const pattern of patterns) {
    const p = pattern.trim();
    if (!p) continue;

    // ** = prefix match (directory and all descendants)
    if (p.endsWith("/**")) {
      const prefix = p.slice(0, -3);
      if (prefix === "" || normalized === prefix || normalized.startsWith(prefix + "/")) {
        return true;
      }
      continue;
    }

    // * at start only: suffix match (e.g. *.pem)
    if (p.startsWith("*.")) {
      const suffix = p.slice(1);
      if (normalized === suffix || normalized.endsWith("/" + suffix) || normalized.endsWith(suffix)) return true;
      continue;
    }

    // * at end only: prefix match for basename (e.g. .env*)
    if (p.endsWith("*") && !p.includes("*", 1)) {
      const prefix = p.slice(0, -1);
      const basename = normalized.includes("/") ? normalized.split("/").pop() ?? normalized : normalized;
      if (basename === prefix || basename.startsWith(prefix)) return true;
      continue;
    }

    // Exact match
    if (normalized === p) return true;
  }

  return false;
}

/**
 * Filter a list of paths to those that are protected.
 */
export function getProtectedPaths(
  paths: string[],
  patterns: readonly ProtectedPattern[] = DEFAULT_PROTECTED_PATTERNS
): string[] {
  return paths.filter((path) => isProtectedPath(path, patterns));
}

export type OverEditCheck = {
  path: string;
  replacedRatio: number;
  fileLength: number;
  oldContentLength: number;
};

/**
 * Check if a file_edit step would replace more than OVER_EDIT_RATIO_THRESHOLD of the file.
 * oldContentLength and fileLength should be in characters (or lines); we use length ratio.
 */
export function checkOverEdit(
  fileLength: number,
  oldContentLength: number,
  newContentLength: number
): { overEdit: boolean; replacedRatio: number } {
  if (fileLength <= 0) return { overEdit: false, replacedRatio: 0 };
  const replacedRatio = oldContentLength / fileLength;
  return {
    overEdit: replacedRatio > OVER_EDIT_RATIO_THRESHOLD,
    replacedRatio,
  };
}
