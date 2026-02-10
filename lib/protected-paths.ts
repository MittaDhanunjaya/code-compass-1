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

/** Check if path matches a directory-prefix pattern (e.g. "infra/**" matches infra/...) */
function matchesDirectoryPrefix(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(prefix + "/");
}

/** Check if path matches a basename prefix pattern (e.g. ".env*" matches .env, .env.local) */
function matchesBasenamePrefix(path: string, prefix: string): boolean {
  const basename = path.includes("/") ? path.split("/").pop() ?? path : path;
  return basename === prefix || basename.startsWith(prefix);
}

/** Check if path matches a suffix pattern (e.g. "*.pem" matches key.pem, certs/key.pem) */
function matchesSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith("/" + suffix) || path.endsWith(suffix);
}

/** Check if a single pattern matches the given path. */
function singlePatternMatches(path: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;

  if (p.endsWith("/**")) {
    return matchesDirectoryPrefix(path, p.slice(0, -3));
  }
  if (p.startsWith("*.")) {
    return matchesSuffix(path, p.slice(1));
  }
  // * only at end: basename prefix (e.g. .env*)
  if (p.endsWith("*") && p.indexOf("*") === p.length - 1) {
    return matchesBasenamePrefix(path, p.slice(0, -1));
  }
  return path === p;
}

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
    if (singlePatternMatches(normalized, pattern)) return true;
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
