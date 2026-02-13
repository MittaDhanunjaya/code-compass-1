/**
 * Universal Plan Contract: strict JSON schema for agent plans.
 * Reject plans that do not conform. Require clarifying questions if schema cannot be satisfied.
 */

import type { AgentPlan, FileEditStep, CommandStep } from "./types";

/** Plan mode: reproducible (deterministic) vs exploratory. */
export type PlanMode = "reproducible" | "exploratory";

/** Stack info (nullable per layer). */
export type PlanStack = {
  frontend?: string | null;
  backend?: string | null;
  db?: string | null;
  infra?: string | null;
};

/** Component with explicit path and purpose. */
export type PlanComponent = {
  path: string;
  purpose: string;
};

/** Commands (install, dev, build). */
export type PlanCommands = {
  install?: string;
  dev?: string;
  build?: string;
};

/** Strict universal plan schema. */
export type UniversalPlan = {
  goal: string;
  assumptions: string[];
  stack: PlanStack | null;
  components: PlanComponent[];
  commands: PlanCommands;
  success_criteria: string[];
  steps: AgentPlan["steps"];
};

/** Result of validating a plan against the contract. */
export type PlanContractResult =
  | { ok: true; plan: UniversalPlan }
  | { ok: false; reason: string; clarifyingQuestions?: string[] };

/** Check if raw plan has required universal fields. */
function hasUniversalFields(obj: unknown): obj is Record<string, unknown> & {
  goal?: unknown;
  assumptions?: unknown;
  stack?: unknown;
  components?: unknown;
  commands?: unknown;
  success_criteria?: unknown;
  steps?: unknown;
} {
  if (obj == null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.goal === "string" &&
    Array.isArray(o.assumptions) &&
    Array.isArray(o.success_criteria) &&
    Array.isArray(o.components) &&
    Array.isArray(o.steps)
  );
}

/** Validate a single component. */
function isValidComponent(c: unknown): c is PlanComponent {
  if (c == null || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return typeof o.path === "string" && o.path.trim().length > 0 && typeof o.purpose === "string";
}

/** Validate steps match components (every file_edit path must be in components). */
function stepsMatchComponents(
  steps: AgentPlan["steps"],
  components: PlanComponent[]
): { ok: boolean; orphanPath?: string } {
  const componentPaths = new Set(components.map((c) => c.path.trim()));
  for (const step of steps) {
    if (step.type === "file_edit") {
      const p = step.path.trim();
      if (!componentPaths.has(p)) {
        return { ok: false, orphanPath: p };
      }
    }
  }
  return { ok: true };
}

/** Every component must have a corresponding file_edit step. */
function componentsHaveSteps(
  components: PlanComponent[],
  steps: AgentPlan["steps"]
): { ok: boolean; missingPath?: string } {
  const stepPaths = new Set(
    steps.filter((s): s is FileEditStep => s.type === "file_edit").map((s) => s.path.trim())
  );
  for (const c of components) {
    if (!stepPaths.has(c.path.trim())) {
      return { ok: false, missingPath: c.path };
    }
  }
  return { ok: true };
}

/** Normalize stack to PlanStack | null. */
function normalizeStack(s: unknown): PlanStack | null {
  if (s == null) return null;
  if (typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  return {
    frontend: typeof o.frontend === "string" ? o.frontend : null,
    backend: typeof o.backend === "string" ? o.backend : null,
    db: typeof o.db === "string" ? o.db : null,
    infra: typeof o.infra === "string" ? o.infra : null,
  };
}

/** Normalize commands. */
function normalizeCommands(c: unknown): PlanCommands {
  if (c == null || typeof c !== "object") return {};
  const o = c as Record<string, unknown>;
  return {
    install: typeof o.install === "string" ? o.install : undefined,
    dev: typeof o.dev === "string" ? o.dev : undefined,
    build: typeof o.build === "string" ? o.build : undefined,
  };
}

/** Parse and validate steps array. */
function parseSteps(steps: unknown): AgentPlan["steps"] | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const result: AgentPlan["steps"] = [];
  for (const s of steps) {
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      if (o.type === "file_edit" && typeof o.path === "string" && typeof o.newContent === "string") {
        result.push({
          type: "file_edit",
          path: o.path,
          oldContent: typeof o.oldContent === "string" ? o.oldContent : undefined,
          newContent: o.newContent,
          description: typeof o.description === "string" ? o.description : undefined,
        } as FileEditStep);
      } else if (o.type === "command" && typeof o.command === "string") {
        result.push({
          type: "command",
          command: o.command,
          description: typeof o.description === "string" ? o.description : undefined,
        } as CommandStep);
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  return result;
}

/**
 * Validate plan against universal contract.
 * Rejects if schema cannot be satisfied.
 */
export function validatePlanContract(obj: unknown): PlanContractResult {
  if (!hasUniversalFields(obj)) {
    return {
      ok: false,
      reason: "Plan must include: goal, assumptions, stack, components, commands, success_criteria, steps",
      clarifyingQuestions: [
        "What is the primary goal of this task?",
        "What are the main deliverables (file paths and their purposes)?",
        "What are the success criteria?",
      ],
    };
  }

  const o = obj as Record<string, unknown>;
  const goal = String(o.goal).trim();
  if (!goal) {
    return {
      ok: false,
      reason: "goal is required and must be non-empty",
      clarifyingQuestions: ["What is the primary goal of this task?"],
    };
  }

  const assumptions = Array.isArray(o.assumptions)
    ? o.assumptions.filter((a): a is string => typeof a === "string")
    : [];
  const success_criteria = Array.isArray(o.success_criteria)
    ? o.success_criteria.filter((s): s is string => typeof s === "string")
    : [];
  if (success_criteria.length === 0) {
    return {
      ok: false,
      reason: "success_criteria must have at least one item",
      clarifyingQuestions: ["How will we know when the task is complete?"],
    };
  }

  const rawComponents = o.components as unknown[];
  const components: PlanComponent[] = [];
  for (const c of rawComponents) {
    if (!isValidComponent(c)) {
      return {
        ok: false,
        reason: `Invalid component: each must have path (non-empty string) and purpose (string)`,
        clarifyingQuestions: ["List each file to create/modify with its purpose."],
      };
    }
    components.push(c);
  }

  if (components.length === 0) {
    return {
      ok: false,
      reason: "components must have at least one item with path and purpose",
      clarifyingQuestions: ["Which files will be created or modified?"],
    };
  }

  const steps = parseSteps(o.steps);
  if (!steps || steps.length === 0) {
    return {
      ok: false,
      reason: "steps must be a non-empty array of file_edit and command objects",
      clarifyingQuestions: ["Provide concrete file edits and commands to execute."],
    };
  }

  const stepMatch = stepsMatchComponents(steps, components);
  if (!stepMatch.ok) {
    return {
      ok: false,
      reason: `File path "${stepMatch.orphanPath}" in steps is not declared in components`,
      clarifyingQuestions: ["Every file_edit step must have a matching component with path and purpose."],
    };
  }

  const compMatch = componentsHaveSteps(components, steps);
  if (!compMatch.ok) {
    return {
      ok: false,
      reason: `Component "${compMatch.missingPath}" has no corresponding file_edit step`,
      clarifyingQuestions: ["Every component must have a file_edit step."],
    };
  }

  const plan: UniversalPlan = {
    goal,
    assumptions,
    stack: normalizeStack(o.stack),
    components,
    commands: normalizeCommands(o.commands),
    success_criteria,
    steps,
  };

  return { ok: true, plan };
}

/**
 * Convert legacy AgentPlan (steps + summary) to UniversalPlan for backward compatibility.
 * Used when LLM returns old format; we synthesize goal/success_criteria from steps.
 */
export function legacyPlanToUniversal(legacy: AgentPlan): UniversalPlan {
  const filePaths = legacy.steps
    .filter((s): s is FileEditStep => s.type === "file_edit")
    .map((s) => s.path.trim());
  const components: PlanComponent[] = filePaths.map((path) => ({
    path,
    purpose: legacy.steps.find((s) => s.type === "file_edit" && s.path === path)?.description ?? "part of plan",
  }));
  const commands: PlanCommands = {};
  for (const s of legacy.steps) {
    if (s.type === "command") {
      const c = s.command.toLowerCase();
      if (/npm\s+install|yarn\s+install|pnpm\s+install|pip\s+install/.test(c)) commands.install = s.command;
      else if (/npm\s+run\s+dev|yarn\s+dev|npm\s+start/.test(c)) commands.dev = s.command;
      else if (/npm\s+run\s+build|yarn\s+build/.test(c)) commands.build = s.command;
    }
  }
  return {
    goal: legacy.summary ?? "Complete the requested task",
    assumptions: [],
    stack: null,
    components,
    commands,
    success_criteria: ["Task completed as specified"],
    steps: legacy.steps,
  };
}

/** Extract execution-only AgentPlan from UniversalPlan. */
export function toAgentPlan(plan: UniversalPlan): AgentPlan {
  return { steps: plan.steps, summary: plan.goal };
}
