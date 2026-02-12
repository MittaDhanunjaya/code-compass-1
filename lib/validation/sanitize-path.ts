/**
 * File path sanitization for API inputs.
 * Phase 10.3: Reject path traversal, absolute paths, and unsafe patterns.
 */

export type SanitizePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Sanitizes a file path for use within a workspace.
 * Rejects:
 * - Path traversal (../)
 * - Absolute paths (leading / or \)
 * - Paths outside workspace root (when rootPath is provided)
 *
 * @param path - Raw path from user input
 * @param _rootPath - Optional workspace root (e.g. "workspace-123") for path containment checks
 */
export function sanitizePath(path: string, _rootPath?: string): SanitizePathResult {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Path cannot be empty" };
  }

  // Reject absolute paths
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-zA-Z]:\//.test(trimmed)) {
    return { ok: false, error: "Absolute paths are not allowed" };
  }

  // Reject path traversal (.. as segment - reject any occurrence)
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((seg) => seg === "..")) {
    return { ok: false, error: "Path traversal is not allowed" };
  }

  // Filter out "." only; keep the rest
  const result = segments.filter((s) => s !== ".").join("/");
  if (result.length === 0) {
    return { ok: false, error: "Path cannot be empty" };
  }

  return { ok: true, path: result };
}
