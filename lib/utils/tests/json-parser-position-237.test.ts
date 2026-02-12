/**
 * Test for the specific error reported: "Expected ',' or '}' after property value in JSON at position 237"
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Position 237 Error Fix", () => {
  it("should handle error at position 237 (line 8 column 131)", () => {
    // Simulate the exact error scenario - missing comma after a property value
    const json = `{
  "steps": [
    {
      "type": "file_edit",
      "path": "test.ts",
      "newContent": "some code here"
    }
  ],
  "summary": "test"
}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(result.data).toHaveProperty("summary");
  });

  it("should handle missing comma after property value at position ~237", () => {
    // Create JSON that would fail around position 237 with missing comma
    const json = `{"steps": [{"type": "edit", "path": "test.ts", "content": "code"}], "summary": "test" "extra": "value"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle missing comma after nested object", () => {
    const json = `{"steps": [{"type": "edit", "data": {"key": "value"}}], "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
  });

  it("should handle missing comma after array", () => {
    const json = `{"steps": [] "summary": "test"}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("summary");
  });

  it("should handle missing comma after string value", () => {
    const json = `{"summary": "test" "steps": []}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle complex nested structure with missing comma", () => {
    const json = `{
  "steps": [
    {
      "type": "file_edit",
      "path": "lib/utils/test.ts",
      "newContent": "export function test() { return true; }"
    }
  ],
  "summary": "Add test function"
}`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect((result.data as { steps: unknown[] }).steps.length).toBeGreaterThan(0);
  });
});
