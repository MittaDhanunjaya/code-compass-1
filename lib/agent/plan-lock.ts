/**
 * Plan → Execution Lock: hash approved plan, executor may only write files listed in plan.
 * Abort if any file path not in plan is attempted.
 */

import { createHash } from "crypto";
import type { AgentPlan, FileEditStep } from "./types";

/** Stable hash of plan for execution lock. Order-independent for file list. */
export function hashPlan(plan: AgentPlan): string {
  const normalized = plan.steps.map((s) => {
    if (s.type === "file_edit") {
      return { type: "file_edit" as const, path: s.path.trim() };
    }
    return { type: "command" as const, command: s.command };
  });
  normalized.sort((a, b) => {
    if (a.type !== b.type) return a.type === "file_edit" ? -1 : 1;
    const keyA = a.type === "file_edit" ? a.path : a.command;
    const keyB = b.type === "file_edit" ? b.path : b.command;
    return keyA.localeCompare(keyB);
  });
  const canonical = JSON.stringify({ steps: normalized });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Extract allowed file paths from plan (create + edit). */
export function getAllowedPaths(plan: AgentPlan): Set<string> {
  const paths = new Set<string>();
  for (const step of plan.steps) {
    if (step.type === "file_edit") {
      paths.add(step.path.trim());
    }
  }
  return paths;
}

/** Result of checking if a path is allowed. */
export type PathCheckResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Check if a file path is allowed under the plan lock.
 * Returns reason when not allowed.
 */
export function isPathAllowed(path: string, allowedPaths: Set<string>): PathCheckResult {
  const normalized = path.trim();
  if (!normalized) return { allowed: false, reason: "Path cannot be empty" };
  if (!allowedPaths.has(normalized)) {
    return {
      allowed: false,
      reason: `Path "${normalized}" is not in the approved plan. Executor may only write files listed in the plan.`,
    };
  }
  return { allowed: true };
}

/**
 * Filter file edit steps to only those allowed by the plan.
 * Returns { allowed, rejected } - rejected includes paths not in plan.
 */
export function filterStepsByPlan(
  steps: FileEditStep[],
  allowedPaths: Set<string>
): { allowed: FileEditStep[]; rejected: { path: string; reason: string }[] } {
  const allowed: FileEditStep[] = [];
  const rejected: { path: string; reason: string }[] = [];
  for (const step of steps) {
    const check = isPathAllowed(step.path, allowedPaths);
    if (check.allowed) {
      allowed.push(step);
    } else {
      rejected.push({ path: step.path.trim(), reason: check.reason });
    }
  }
  return { allowed, rejected };
}
