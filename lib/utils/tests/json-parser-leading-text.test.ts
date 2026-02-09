/**
 * Tests for JSON parser handling leading explanatory text.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Leading Text Handling", () => {
  it("should skip 'Looking at...' prefix", () => {
    const json = 'Looking at the codebase, here is the plan: {"steps": [], "summary": "test"}';
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should skip 'Here is...' prefix", () => {
    const json = 'Here is the plan: {"steps": [{"type": "file_edit"}], "summary": "test"}';
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle multi-line leading text", () => {
    const json = `I'll analyze the codebase and create a plan.

Here's what I'll do:
{"steps": [], "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should find JSON even with lots of leading text", () => {
    const json = `Looking at the error and the codebase structure, I can see that we need to fix several things. Let me create a comprehensive plan:

{"steps": [{"type": "file_edit", "path": "test.ts"}], "summary": "Fix issues"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(Array.isArray(result.data?.steps)).toBe(true);
  });

  it("should handle JSON in markdown code blocks with leading text", () => {
    const json = `Here's the plan:

\`\`\`json
{"steps": [], "summary": "test"}
\`\`\``;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });
});
