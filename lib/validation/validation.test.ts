/**
 * Phase 3.4.3: Unit tests for planner schema validation.
 */

import { describe, it, expect } from "vitest";
import {
  agentPlanOutputSchema,
  agentPlanStreamBodySchema,
  agentExecuteStreamBodySchema,
  chatStreamBodySchema,
} from "./schemas";
import { hashPlan } from "@/lib/agent/plan-lock";
import { validateBody, validateAgentPlanOutput, validatePrAnalyzeOutput, validateDebugFromLogOutput } from "./index";

describe("agentPlanOutputSchema", () => {
  it("accepts valid plan with file_edit and command steps", () => {
    const plan = {
      steps: [
        { type: "file_edit", path: "src/app.ts", newContent: "content" },
        { type: "command", command: "npm test" },
      ],
      summary: "Test plan",
    };
    const result = agentPlanOutputSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("accepts plan with file_edit using oldContent", () => {
    const plan = {
      steps: [
        { type: "file_edit", path: "src/app.ts", oldContent: "old", newContent: "new" },
      ],
    };
    const result = agentPlanOutputSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it("rejects empty steps array", () => {
    const plan = { steps: [] };
    const result = agentPlanOutputSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects steps with invalid type", () => {
    const plan = {
      steps: [{ type: "invalid", path: "x" }],
    };
    const result = agentPlanOutputSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects file_edit without path", () => {
    const plan = {
      steps: [{ type: "file_edit", newContent: "x" }],
    };
    const result = agentPlanOutputSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it("rejects command without command string", () => {
    const plan = {
      steps: [{ type: "command", command: "" }],
    };
    const result = agentPlanOutputSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe("validateAgentPlanOutput", () => {
  it("returns success for valid plan", () => {
    const parsed = {
      steps: [{ type: "file_edit", path: "a.ts", newContent: "x" }],
    };
    const result = validateAgentPlanOutput(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(1);
      expect(result.data.steps[0].type).toBe("file_edit");
    }
  });

  it("returns error for invalid plan", () => {
    const parsed = { steps: [] };
    const result = validateAgentPlanOutput(parsed);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("step");
    }
  });
});

describe("validateBody", () => {
  it("validates agentPlanStreamBodySchema", () => {
    const body = { instruction: "Add a button", workspaceId: "00000000-0000-0000-0000-000000000000" };
    const result = validateBody(agentPlanStreamBodySchema, body);
    expect(result.success).toBe(true);
  });

  it("rejects empty instruction", () => {
    const result = validateBody(agentPlanStreamBodySchema, { instruction: "" });
    expect(result.success).toBe(false);
  });

  it("validates chatStreamBodySchema", () => {
    const body = { messages: [{ role: "user", content: "Hello" }] };
    const result = validateBody(chatStreamBodySchema, body);
    expect(result.success).toBe(true);
  });

  it("rejects empty messages", () => {
    const result = validateBody(chatStreamBodySchema, { messages: [] });
    expect(result.success).toBe(false);
  });

  it("validates agentExecuteStreamBodySchema", () => {
    const plan = { steps: [{ type: "file_edit", path: "a.ts", newContent: "x" }] };
    const body = {
      plan,
      planHash: hashPlan(plan),
    };
    const result = validateBody(agentExecuteStreamBodySchema, body);
    expect(result.success).toBe(true);
  });

  it("rejects execute without plan", () => {
    const result = validateBody(agentExecuteStreamBodySchema, {});
    expect(result.success).toBe(false);
  });

  it("rejects execute without planHash", () => {
    const plan = { steps: [{ type: "file_edit", path: "a.ts", newContent: "x" }] };
    const result = validateBody(agentExecuteStreamBodySchema, { plan });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/planHash|required/i);
  });
});

describe("validatePrAnalyzeOutput", () => {
  it("returns validated output for valid parsed object", () => {
    const parsed = { summary: "Changed X", risks: ["risk1"], suggestions: ["sug1"] };
    const result = validatePrAnalyzeOutput(parsed);
    expect(result.summary).toBe("Changed X");
    expect(result.risks).toEqual(["risk1"]);
    expect(result.suggestions).toEqual(["sug1"]);
  });

  it("returns safe defaults for invalid parsed", () => {
    const result = validatePrAnalyzeOutput({ foo: "bar" });
    expect(result.summary).toBe("");
    expect(result.risks).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });
});

describe("validateDebugFromLogOutput", () => {
  it("returns validated output for valid parsed object", () => {
    const parsed = {
      suspectedRootCause: "Missing import",
      explanation: "Fixed by adding import",
      edits: [{ path: "a.ts", newContent: "x" }],
    };
    const result = validateDebugFromLogOutput(parsed);
    expect(result.suspectedRootCause).toBe("Missing import");
    expect(result.explanation).toBe("Fixed by adding import");
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].path).toBe("a.ts");
  });

  it("returns null/empty for invalid parsed", () => {
    const result = validateDebugFromLogOutput({ foo: "bar" });
    expect(result.suspectedRootCause).toBeNull();
    expect(result.explanation).toBeNull();
    expect(result.edits).toEqual([]);
  });
});
