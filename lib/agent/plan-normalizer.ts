/**
 * Plan normalization for deterministic mode.
 * Sort files by path, enforce max depth (3 nested dirs), stable root layout.
 * Hash plan AFTER normalization.
 */

import type { AgentPlan, FileEditStep, CommandStep } from "./types";
import { hashPlan } from "./plan-lock";

const MAX_PATH_DEPTH = 3; // e.g. a/b/c/file.ts

/** Normalize path: trim, collapse ./ */
function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/\/+/g, "/");
}

/** Count directory depth (segments before filename). */
function pathDepth(path: string): number {
  const parts = path.split("/").filter(Boolean);
  return Math.max(0, parts.length - 1);
}

/** Reject paths exceeding max depth. Returns error message or null. */
function validatePathDepth(path: string): string | null {
  const depth = pathDepth(normalizePath(path));
  if (depth > MAX_PATH_DEPTH) {
    return `Path "${path}" exceeds max depth of ${MAX_PATH_DEPTH} nested directories`;
  }
  return null;
}

export type NormalizePlanResult =
  | { ok: true; plan: AgentPlan; planHash: string }
  | { ok: false; error: string };

/**
 * Normalize plan for deterministic mode:
 * - Sort file_edit steps by path
 * - Sort command steps by command string
 * - Enforce max depth on file paths
 * - Hash AFTER normalization
 */
export function normalizePlanForDeterministic(plan: AgentPlan): NormalizePlanResult {
  const fileSteps = plan.steps.filter((s): s is FileEditStep => s.type === "file_edit");
  const cmdSteps = plan.steps.filter((s): s is CommandStep => s.type === "command");

  for (const s of fileSteps) {
    const err = validatePathDepth(s.path);
    if (err) return { ok: false, error: err };
  }

  const sortedFileSteps = [...fileSteps].sort((a, b) =>
    normalizePath(a.path).localeCompare(normalizePath(b.path))
  );
  const sortedCmdSteps = [...cmdSteps].sort((a, b) =>
    (a.command || "").localeCompare(b.command || "")
  );

  const normalizedPlan: AgentPlan = {
    ...plan,
    steps: [...sortedFileSteps, ...sortedCmdSteps],
  };

  const planHash = hashPlan(normalizedPlan);
  return { ok: true, plan: normalizedPlan, planHash };
}
