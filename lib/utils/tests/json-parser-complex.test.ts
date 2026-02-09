/**
 * Tests for complex real-world JSON parsing scenarios.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Complex Real-World Scenarios", () => {
  it("should handle JSON with leading text and control characters", () => {
    const json = `Looking at the codebase, here's the plan:
{
  "steps": [
    {
      "type": "file_edit",
      "path": "test.ts",
      "newContent": "function test() {\n  return true;\n}"
    }
  ],
  "summary": "test"
}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle JSON with trailing commas and control characters", () => {
    const json = `{
  "steps": [
    {
      "type": "file_edit",
      "newContent": "code\nwith\nnewlines",
    },
  ],
  "summary": "test",
}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle JSON with missing commas and control characters", () => {
    const json = `{
  "steps": [{"type": "file_edit", "newContent": "line1\nline2"}]
  "summary": "test"
}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(result.data).toHaveProperty("summary");
  });

  it("should handle control characters at position 96 (reported error)", () => {
    // Simulate error: "Bad control character in string literal at position 96"
    const json = `{"steps": [{"type": "file_edit", "path": "test.ts", "newContent": "function test() {\n  console.log('hello');\n}"}], "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });
});
