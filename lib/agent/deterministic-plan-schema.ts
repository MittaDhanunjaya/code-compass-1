/**
 * Deterministic Planning Contract: strict Zod schema for agent plans.
 * Enforces invariants: files.length > 0, no duplicate paths, every file has purpose.
 * Execution phase may only write to paths declared in plan.files.
 */

import { z } from "zod";
import { sanitizePath } from "@/lib/validation/sanitize-path";
import { hashPlan } from "./plan-lock";
import type { AgentPlan, FileEditStep, CommandStep } from "./types";

const architectureSchema = z.enum(["monolith", "microservices", "serverless"]);

const planStackSchema = z.object({
  frontend: z.string().optional(),
  backend: z.string().optional(),
  database: z.string().optional(),
});

const planFileSchema = z
  .object({
    path: z.string().min(1, "path is required"),
    purpose: z.string().min(1, "purpose is required"),
    dependsOn: z.array(z.string()).optional(),
  })
  .refine(
    (f) => {
      const r = sanitizePath(f.path.trim());
      return r.ok;
    },
    { message: "path contains invalid characters" }
  );

const fileEditStepSchema = z.object({
  type: z.literal("file_edit"),
  path: z.string().min(1),
  oldContent: z.string().optional(),
  newContent: z.string(),
  description: z.string().optional(),
  source: z.literal("debug-from-log").optional(),
});

const commandStepSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  description: z.string().optional(),
});

const planStepSchema = z.discriminatedUnion("type", [fileEditStepSchema, commandStepSchema]);

/** Strict deterministic plan schema (canonical format from LLM). */
export const deterministicPlanSchema = z
  .object({
    goal: z.string().optional(),
    summary: z.string().optional(),
    architecture: architectureSchema.default("monolith"),
    stack: planStackSchema.optional(),
    files: z
      .array(planFileSchema)
      .min(1, "files must have at least one entry")
      .refine(
        (arr) => {
          const paths = arr.map((f) => f.path.trim());
          const seen = new Set<string>();
          for (const p of paths) {
            if (seen.has(p)) return false;
            seen.add(p);
          }
          return true;
        },
        { message: "files must not contain duplicate paths" }
      )
      .refine(
        (arr) => arr.every((f) => typeof f.purpose === "string" && f.purpose.trim().length > 0),
        { message: "every file must have a non-empty purpose" }
      ),
    executionSteps: z.array(z.string()).default([]),
    steps: z.array(planStepSchema).min(1, "steps must have at least one entry"),
  })
  .refine(
    (data) => {
      const filePaths = new Set(data.files.map((f) => f.path.trim()));
      for (const step of data.steps) {
        if (step.type === "file_edit" && !filePaths.has(step.path.trim())) {
          return false;
        }
      }
      return true;
    },
    { message: "every file_edit step path must be declared in files" }
  )
  .transform((data) => ({
    ...data,
    goal: data.goal || data.summary || "Plan",
  }));

export type DeterministicPlan = z.infer<typeof deterministicPlanSchema>;

/** Legacy plan format (steps + summary only). We derive files from steps and validate invariants. */
const legacyPlanSchema = z.object({
  steps: z.array(planStepSchema).min(1, "at least one step is required"),
  summary: z.string().optional(),
});

export type PlanValidationResult =
  | { success: true; plan: AgentPlan; allowedPaths: Set<string>; planHash: string }
  | { success: false; error: string };

/** Validate and normalize plan. Accepts both deterministic and legacy formats. */
export function validateDeterministicPlan(parsed: unknown): PlanValidationResult {
  const hasFiles = parsed && typeof parsed === "object" && Array.isArray((parsed as { files?: unknown }).files);
  // Try deterministic format first when files array is present
  if (hasFiles) {
    const detResult = deterministicPlanSchema.safeParse(parsed);
    if (detResult.success) {
      const d = detResult.data;
      const plan: AgentPlan = {
        steps: d.steps as (FileEditStep | CommandStep)[],
        summary: d.goal,
        files: d.files.map((f) => ({ path: f.path.trim(), purpose: f.purpose })),
      };
      const allowedPaths = new Set(d.files.map((f) => f.path.trim()));
      const planHash = hashPlanForValidation(plan);
      return { success: true, plan, allowedPaths, planHash };
    }
    const err = detResult.error;
    const first = err.issues[0];
    const msg = first ? `${first.path.join(".")}: ${first.message}` : "Invalid deterministic plan structure";
    return { success: false, error: msg };
  }

  // Fall back to legacy format
  const legacyResult = legacyPlanSchema.safeParse(parsed);
  if (!legacyResult.success) {
    const err = legacyResult.error;
    const first = err.issues[0];
    const msg = first ? `${first.path.join(".")}: ${first.message}` : "Invalid plan structure";
    return { success: false, error: msg };
  }

  const legacy = legacyResult.data;
  const fileEditSteps = legacy.steps.filter((s): s is FileEditStep => s.type === "file_edit");

  if (fileEditSteps.length === 0) {
    return { success: false, error: "Plan must include at least one file to create or modify" };
  }

  const paths = fileEditSteps.map((s) => s.path.trim());
  const seen = new Set<string>();
  for (const p of paths) {
    if (seen.has(p)) {
      return { success: false, error: `Duplicate file path: ${p}` };
    }
    seen.add(p);
  }

  const allowedPaths = new Set(paths);
  const plan: AgentPlan = { steps: legacy.steps as (FileEditStep | CommandStep)[], summary: legacy.summary };
  const planHash = hashPlanForValidation(plan);
  return { success: true, plan, allowedPaths, planHash };
}

/** Stable hash for plan (for execution lock verification). */
export function hashPlanForValidation(plan: AgentPlan): string {
  return hashPlan(plan);
}
