/**
 * Deterministic Planning Contract: enforce files[] declaration.
 * Every file_edit step path must exist in plan.files[].
 * Reject plans where steps introduce files not declared in files[].
 */

import type { AgentPlan, FileEditStep } from "./types";

export type PlanContractResult =
  | { valid: true; declaredPaths: Set<string> }
  | { valid: false; code: "INVALID_PLAN_CONTRACT"; undeclaredPaths: string[] };

/** Corrective hint for contract violations. */
export const PLAN_CONTRACT_CORRECTIVE_HINT = `
[System: You must declare all files upfront in files[]. Do not invent new files in steps.
Output a "files" array: [{"path": "...", "purpose": "..."}] with every file you will create or modify.
Every file_edit step path MUST appear in files[]. Output ONLY valid JSON.]`;

/**
 * Validate plan contract: when files[] is present, every file_edit path must be in it.
 * When files[] is absent (legacy), derive declared set from steps (no undeclared files possible).
 */
export function validatePlanContract(plan: AgentPlan): PlanContractResult {
  const fileSteps = plan.steps.filter((s): s is FileEditStep => s.type === "file_edit");
  if (fileSteps.length === 0) {
    return { valid: true, declaredPaths: new Set() };
  }

  const planWithFiles = plan as AgentPlan & { files?: Array<{ path: string; purpose?: string }> };
  const files = planWithFiles.files;

  if (files && Array.isArray(files) && files.length > 0) {
    const declaredPaths = new Set(files.map((f) => (f.path || "").trim()).filter(Boolean));
    const undeclared: string[] = [];
    for (const step of fileSteps) {
      const p = step.path.trim();
      if (p && !declaredPaths.has(p)) {
        undeclared.push(p);
      }
    }
    if (undeclared.length > 0) {
      return { valid: false, code: "INVALID_PLAN_CONTRACT", undeclaredPaths: undeclared };
    }
    return { valid: true, declaredPaths };
  }

  // Legacy: derive from steps (all paths are "declared" by construction)
  const declaredPaths = new Set(fileSteps.map((s) => s.path.trim()).filter(Boolean));
  return { valid: true, declaredPaths };
}
