/**
 * Tests for plan contract validation.
 */

import { describe, it, expect } from "vitest";
import { validatePlanContract } from "./plan-contract";

describe("validatePlanContract", () => {
  it("rejects plan when steps reference undeclared files (INVALID_PLAN_CONTRACT)", () => {
    const plan = {
      files: [{ path: "src/a.ts", purpose: "main" }],
      steps: [
        { type: "file_edit" as const, path: "src/a.ts", newContent: "a" },
        { type: "file_edit" as const, path: "src/invented.ts", newContent: "invented" },
      ],
      summary: "Plan",
    };
    const result = validatePlanContract(plan);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("INVALID_PLAN_CONTRACT");
      expect(result.undeclaredPaths).toContain("src/invented.ts");
    }
  });

  it("accepts plan when all file_edit paths are in files[]", () => {
    const plan = {
      files: [
        { path: "src/a.ts", purpose: "main" },
        { path: "src/b.ts", purpose: "util" },
      ],
      steps: [
        { type: "file_edit" as const, path: "src/a.ts", newContent: "a" },
        { type: "file_edit" as const, path: "src/b.ts", newContent: "b" },
        { type: "command" as const, command: "npm test" },
      ],
      summary: "Plan",
    };
    const result = validatePlanContract(plan);
    expect(result.valid).toBe(true);
  });

  it("accepts legacy plan without files[] (derives from steps)", () => {
    const plan = {
      steps: [
        { type: "file_edit" as const, path: "src/a.ts", newContent: "a" },
        { type: "command" as const, command: "npm test" },
      ],
      summary: "Plan",
    };
    const result = validatePlanContract(plan);
    expect(result.valid).toBe(true);
  });
});
