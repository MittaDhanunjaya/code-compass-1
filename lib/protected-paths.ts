/**
 * Protected file/path patterns the AI will not edit without extra confirmation (in Safe edit mode).
 * Simple glob-like matching: * = any chars in segment, ** = path prefix.
 */

/** In Safe edit mode, AI operations that would modify more than this many files require extra confirmation. */
export const SAFE_EDIT_MAX_FILES = 20;

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
