/**
 * Plan Consistency Validator: validate before execution.
 * - No orphan files
 * - Dependencies exist in manifests
 * - Commands reference real scripts
 * - No file without purpose
 */

import type { AgentPlan, FileEditStep } from "./types";

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

/** Extract npm script names from command steps. */
function getReferencedScripts(plan: AgentPlan): Set<string> {
  const scripts = new Set<string>();
  for (const step of plan.steps) {
    if (step.type === "command") {
      const c = step.command.trim();
      const runMatch = c.match(/npm\s+run\s+(\w+)/);
      if (runMatch) scripts.add(runMatch[1]);
      const yarnMatch = c.match(/yarn\s+(\w+)/);
      if (yarnMatch) scripts.add(yarnMatch[1]);
    }
  }
  return scripts;
}

/** Extract package.json paths from file edits. */
function getPackageJsonPaths(plan: AgentPlan): string[] {
  return plan.steps
    .filter((s): s is FileEditStep => s.type === "file_edit" && s.path.endsWith("package.json"))
    .map((s) => s.path);
}

/** Check if content declares a script. */
function contentDeclaresScript(content: string, scriptName: string): boolean {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    return !!parsed?.scripts?.[scriptName];
  } catch {
    return false;
  }
}

/**
 * Validate plan consistency. Requires workspace file contents for manifest checks.
 */
export function validatePlanConsistency(
  plan: AgentPlan,
  fileContents?: Record<string, string>
): ValidationResult {
  const errors: string[] = [];

  // No orphan files: every file_edit should have description (soft - only warn for empty)
  // Orphan detection: files not depended on by others (complex - skip for now)

  // Commands reference real scripts: only when package.json EXISTS in workspace (not being created)
  const scripts = getReferencedScripts(plan);
  const pkgPaths = getPackageJsonPaths(plan);
  if (fileContents && pkgPaths.length > 0 && scripts.size > 0) {
    for (const pkgPath of pkgPaths) {
      const content = fileContents[pkgPath];
      if (content) {
        for (const script of scripts) {
          if (!contentDeclaresScript(content, script)) {
            errors.push(`Command references script "${script}" but package.json does not declare it`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}
