/**
 * Tests for deterministic plan schema and validation.
 */

import { describe, it, expect } from "vitest";
import { validateDeterministicPlan, hashPlanForValidation } from "./deterministic-plan-schema";

describe("validateDeterministicPlan", () => {
  it("rejects invalid plan with no steps", () => {
    const result = validateDeterministicPlan({ steps: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/at least one step|step required/i);
    }
  });

  it("rejects plan with only command steps (no files)", () => {
    const result = validateDeterministicPlan({
      steps: [{ type: "command", command: "npm install" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/at least one file|file to create/i);
    }
  });

  it("rejects plan with duplicate file paths", () => {
    const result = validateDeterministicPlan({
      steps: [
        { type: "file_edit", path: "src/index.ts", newContent: "a" },
        { type: "file_edit", path: "src/index.ts", newContent: "b" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/duplicate/i);
    }
  });

  it("accepts valid legacy plan with file_edit and command", () => {
    const result = validateDeterministicPlan({
      steps: [
        { type: "file_edit", path: "src/index.ts", newContent: "content" },
        { type: "command", command: "npm install" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.plan.steps).toHaveLength(2);
      expect(result.allowedPaths.has("src/index.ts")).toBe(true);
      expect(result.planHash).toBeDefined();
    }
  });

  it("rejects plan with file_edit path not in files (deterministic format)", () => {
    const result = validateDeterministicPlan({
      goal: "test",
      architecture: "monolith",
      files: [{ path: "a.ts", purpose: "test" }],
      executionSteps: [],
      steps: [
        { type: "file_edit", path: "b.ts", newContent: "x" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("hashPlanForValidation", () => {
  it("produces same hash for identical plans", () => {
    const plan = {
      steps: [
        { type: "file_edit", path: "a.ts", newContent: "x" },
        { type: "command", command: "npm install" },
      ],
    };
    const h1 = hashPlanForValidation(plan);
    const h2 = hashPlanForValidation(plan);
    expect(h1).toBe(h2);
  });

  it("produces different hash for different file paths", () => {
    const p1 = { steps: [{ type: "file_edit", path: "a.ts", newContent: "x" }] };
    const p2 = { steps: [{ type: "file_edit", path: "b.ts", newContent: "x" }] };
    expect(hashPlanForValidation(p1)).not.toBe(hashPlanForValidation(p2));
  });
});
