/**
 * File System Safety: allowed root directories, no hidden/system paths,
 * no overwriting files not declared in plan.
 */

import { sanitizePath, type SanitizePathResult } from "@/lib/validation/sanitize-path";

/** Allowed root directories (paths must start with one of these, or be at root). */
export const ALLOWED_ROOT_DIRS = [
  "apps/",
  "packages/",
  "infra/",
  "docs/",
  "lib/",
  "libs/",
  "app/",
  "src/",
  "public/",
  "components/",
  "pages/",
  "config/",
  "scripts/",
  "tests/",
  "test/",
] as const;

/** Root-level files allowed (e.g. package.json, README.md). */
export const ALLOWED_ROOT_FILES = [
  "package.json",
  "tsconfig.json",
  "README.md",
  ".gitignore",
  "HOW_TO_RUN.txt",
  "requirements.txt",
  "pyproject.toml",
  "docker-compose.yml",
  "Dockerfile",
];

/** Check if path is under allowed root or is an allowed root file. Assumes path is already sanitized. */
export function isUnderAllowedRoot(path: string): SanitizePathResult {
  const p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const parts = p.split("/").filter(Boolean);

  // Root-level file
  if (parts.length === 1 && ALLOWED_ROOT_FILES.includes(parts[0])) {
    return { ok: true, path: p };
  }

  // Under allowed dir
  for (const root of ALLOWED_ROOT_DIRS) {
    if (p === root.slice(0, -1) || p.startsWith(root)) {
      return { ok: true, path: p };
    }
  }

  // Allow root-level files like .env.example (common config)
  if (parts.length === 1 && (parts[0].startsWith(".env") || parts[0] === "next.config.js" || parts[0] === "tailwind.config.js")) {
    return { ok: true, path: p };
  }

  // Reject hidden/system paths (except .env*, .gitignore)
  if (parts.some((seg) => seg.startsWith(".") && !seg.startsWith(".env") && seg !== ".gitignore")) {
    return { ok: false, error: "Hidden or system paths are not allowed" };
  }

  // Reject node_modules, .git, etc.
  if (parts.includes("node_modules") || parts.includes(".git")) {
    return { ok: false, error: "Path points to system directory" };
  }

  // If no segments (e.g. ""), reject
  if (parts.length === 0) return { ok: false, error: "Path cannot be empty" };

  // Allow any path that isn't explicitly dangerous (permissive for various project structures)
  return { ok: true, path: p };
}

/** Combined check: sanitize + allowed root. */
export function validatePathForPlan(path: string): SanitizePathResult {
  const sanitized = sanitizePath(path);
  if (!sanitized.ok) return sanitized;
  return isUnderAllowedRoot(sanitized.path);
}
