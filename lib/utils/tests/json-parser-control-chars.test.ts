/**
 * Tests for control character handling in JSON parser.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Control Character Handling", () => {
  it("should handle unescaped newlines in strings", () => {
    const json = `{"steps": [{"type": "file_edit", "newContent": "line1\nline2"}], "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle unescaped tabs in strings", () => {
    const json = `{"steps": [{"type": "file_edit", "newContent": "line1\tline2"}], "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle control characters in strings", () => {
    // Simulate the error: "Bad control character in string literal at position 96"
    const json = `{"steps": [{"type": "file_edit", "newContent": "code with\nnewline and\ttab"}], "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle multi-line strings with control characters", () => {
    const json = `{
      "steps": [
        {
          "type": "file_edit",
          "newContent": "function test() {\n  return true;\n}"
        }
      ],
      "summary": "test"
    }`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });
});
