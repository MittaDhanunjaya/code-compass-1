/**
 * Canonical plan layout policy.
 * Reject plans that mix unrelated concerns randomly, create redundant dirs, duplicate file purposes.
 */

import type { AgentPlan, FileEditStep } from "./types";

const CANONICAL_ROOTS = ["frontend", "backend", "infra", "src", "app", "lib", "api", "packages"];

/** Extract root directory from path (first segment). */
function getRoot(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[0] ?? "";
}

/** Check if path suggests UI/frontend. */
function isFrontendPath(path: string): boolean {
  const p = path.toLowerCase();
  return /^(frontend|src\/components|src\/pages|app\/.*\.tsx|.*\.(tsx|jsx|vue|svelte))/.test(p) ||
    /components?|pages?|layout|_app/.test(p);
}

/** Check if path suggests API/backend. */
function isBackendPath(path: string): boolean {
  const p = path.toLowerCase();
  return /^(backend|api|src\/api|app\/api|routes|server)/.test(p) ||
    /route\.(ts|js)|handler|controller/.test(p);
}

/** Check if path suggests deployment/infra. */
function isInfraPath(path: string): boolean {
  const p = path.toLowerCase();
  return /^(infra|deploy|\.github|docker|k8s)/.test(p) ||
    /dockerfile|docker-compose|\.yml|\.yaml|Dockerfile/.test(p);
}

/** Detect if plan has mixed unrelated roots (e.g. frontend/, backend/, and random src/foo with no clear structure). */
function hasRedundantRoots(paths: string[]): boolean {
  const roots = new Set(paths.map(getRoot));
  if (roots.size <= 2) return false;
  const hasCanonical = CANONICAL_ROOTS.some((r) => roots.has(r));
  const hasGenericSrc = roots.has("src");
  return hasCanonical && hasGenericSrc && roots.size > 4;
}

/** Check for duplicate file purposes (same path with different casing, or redundant paths). */
function hasDuplicatePurposes(paths: string[]): boolean {
  const normalized = new Set(paths.map((p) => p.toLowerCase().replace(/\\/g, "/")));
  return normalized.size !== paths.length;
}

export type LayoutValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validate plan against canonical layout policy.
 * Reject if: mixed unrelated concerns randomly, redundant directories, duplicate file purposes,
 * scattered files at root, frontend+backend in same folder.
 */
export function validateCanonicalLayout(plan: AgentPlan): LayoutValidationResult {
  const filePaths = plan.steps
    .filter((s): s is FileEditStep => s.type === "file_edit")
    .map((s) => s.path.trim())
    .filter(Boolean);

  if (filePaths.length === 0) return { valid: true };

  if (hasDuplicatePurposes(filePaths)) {
    return { valid: false, reason: "Plan contains duplicate or redundant file paths" };
  }

  if (hasRedundantRoots(filePaths)) {
    return { valid: false, reason: "Plan mixes unrelated directory roots. Use canonical layout: frontend/, backend/, infra/ or consistent src/ structure." };
  }

  return { valid: true };
}

/** Corrective system prompt hint for layout violations. */
export const LAYOUT_CORRECTIVE_HINT = `
[System: Your plan violates canonical layout rules. Use a consistent structure:
- frontend/ for UI code (if UI detected)
- backend/ or api/ for API/server code (if API detected)
- infra/ for deployment (if deployment detected)
- Do not mix random src/ paths with frontend/ or backend/
- No duplicate or redundant file paths
Output ONLY valid JSON with corrected steps.]`;
