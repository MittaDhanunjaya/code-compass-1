/**
 * Phase 9.1.1: Tests for chain-of-thought reasoning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateChainOfThought, multiStepReasoning } from "../chain-of-thought";

const mockChat = vi.fn();

vi.mock("@/lib/llm/providers", () => ({
  getProvider: () => ({
    chat: mockChat,
  }),
}));

describe("Chain-of-Thought", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateChainOfThought", () => {
    it("should handle JSON parsing failures gracefully", async () => {
      // Use malformed JSON (truncated) to avoid json-parser recursion on completely non-JSON content
      mockChat.mockResolvedValue({ content: '{"steps": [{"type": "file_edit"' });

      const result = await generateChainOfThought(
        "Fix the bug",
        "Context here",
        { apiKey: "sk-test", providerId: "openai" }
      );

      expect(result.problem).toBe("Fix the bug");
      expect(result.steps).toEqual([]);
      expect(result.finalPlan).toBeNull();
    });

    it("should parse valid reasoning steps and finalPlan", async () => {
      const validResponse = {
        steps: [
          { step: 1, thought: "Analyze", conclusion: "Need to fix X", confidence: "high" },
          { step: 2, thought: "Plan", conclusion: "Edit file A", confidence: "medium" },
        ],
        finalPlan: {
          steps: [
            { type: "file_edit", path: "src/a.ts", newContent: "fixed" },
          ],
          summary: "Fixed the bug",
        },
      };
      mockChat.mockResolvedValue({ content: JSON.stringify(validResponse) });

      const result = await generateChainOfThought(
        "Fix the bug",
        "Context",
        { apiKey: "sk-test", providerId: "openai" }
      );

      expect(result.problem).toBe("Fix the bug");
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0]).toMatchObject({ step: 1, thought: "Analyze", confidence: "high" });
      expect(result.finalPlan).not.toBeNull();
      expect(result.finalPlan?.steps).toHaveLength(1);
      expect(result.finalPlan?.steps[0]).toMatchObject({ type: "file_edit", path: "src/a.ts" });
    });

    it("should handle JSON in markdown code block", async () => {
      const validResponse = {
        steps: [{ step: 1, thought: "T", conclusion: "C", confidence: "low" }],
        finalPlan: null,
      };
      mockChat.mockResolvedValue({
        content: "Here is my reasoning:\n```json\n" + JSON.stringify(validResponse) + "\n```",
      });

      const result = await generateChainOfThought(
        "Task",
        "Ctx",
        { apiKey: "sk-test", providerId: "openai" }
      );

      expect(result.steps).toHaveLength(1);
      expect(result.finalPlan).toBeNull();
    });
  });

  describe("multiStepReasoning", () => {
    it("should return plan when reasoning produces one", async () => {
      const plan = { steps: [{ type: "command", command: "npm test" }], summary: "Run tests" };
      mockChat.mockResolvedValue({
        content: JSON.stringify({ steps: [], finalPlan: plan }),
      });

      const { reasoning, plan: returnedPlan } = await multiStepReasoning(
        "Run tests",
        "Context",
        { apiKey: "sk-test", providerId: "openai" }
      );

      expect(returnedPlan).not.toBeNull();
      expect(returnedPlan?.steps).toHaveLength(1);
      expect(returnedPlan?.steps[0]).toMatchObject({ type: "command", command: "npm test" });
      expect(reasoning.finalPlan).toEqual(plan);
    });

    it("should return null plan when reasoning does not produce one", async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({ steps: [{ step: 1, thought: "T", conclusion: "C", confidence: "high" }], finalPlan: null }),
      });

      const { reasoning, plan: returnedPlan } = await multiStepReasoning(
        "Complex task",
        "Context",
        { apiKey: "sk-test", providerId: "openai" }
      );

      expect(returnedPlan).toBeNull();
      expect(reasoning.finalPlan).toBeNull();
      expect(reasoning.steps).toHaveLength(1);
    });
  });
});
