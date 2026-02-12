/**
 * Validation for workspace file uploads (local folder / large project creation).
 * Used by POST /api/workspaces to enforce limits.
 * Phase 10.3: Path sanitization (no traversal, no absolute paths).
 */

import { sanitizePath } from "@/lib/validation/sanitize-path";

export const MAX_LOCAL_FILES = 500;
export const MAX_FILE_SIZE = 500_000;

export type LocalFileInput = { path: string; content?: string };

export type ValidateLocalFilesResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

/**
 * Validates local files array for workspace creation.
 * Returns ok: true with count of valid files, or ok: false with error message.
 */
export function validateLocalFiles(files: unknown): ValidateLocalFilesResult {
  if (!Array.isArray(files)) {
    return { ok: false, error: "files must be an array" };
  }
  if (files.length > MAX_LOCAL_FILES) {
    return {
      ok: false,
      error: `Too many files (max ${MAX_LOCAL_FILES}). Use a smaller folder or GitHub import.`,
    };
  }
  for (const f of files) {
    if (f == null || typeof f !== "object" || typeof (f as LocalFileInput).path !== "string") continue;
    const path = (f as LocalFileInput).path.trim();
    if (path.length === 0) continue;
    const r = sanitizePath(path);
    if (!r.ok) return { ok: false, error: `Invalid path: ${r.error}` };
  }
  const valid = files.filter(
    (f): f is LocalFileInput =>
      f != null &&
      typeof f === "object" &&
      typeof (f as LocalFileInput).path === "string" &&
      (f as LocalFileInput).path.trim().length > 0
  );
  return { ok: true, count: valid.length };
}
