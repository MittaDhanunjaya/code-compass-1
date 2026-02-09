/**
 * Tests for trailing comma handling in JSON parser.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Trailing Comma Handling", () => {
  it("should handle trailing comma in object", () => {
    const json = '{"steps": [], "summary": "test",}';
    const result = parseJSONRobust(json);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(result.data).toHaveProperty("summary", "test");
  });

  it("should handle trailing comma in array", () => {
    const json = '{"steps": [{"type": "file_edit"},], "summary": "test"}';
    const result = parseJSONRobust(json);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(Array.isArray(result.data?.steps)).toBe(true);
  });

  it("should handle multiple trailing commas", () => {
    const json = '{"steps": [{"type": "file_edit", "path": "test.ts",},], "summary": "test",}';
    const result = parseJSONRobust(json);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle trailing comma at position 877 (reported error)", () => {
    // Simulate the error case: JSON with trailing comma around position 877
    const json = `{
      "steps": [
        {
          "type": "file_edit",
          "path": "test.ts",
          "newContent": "content here",
        },
      ],
      "summary": "test",
    }`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(Array.isArray(result.data?.steps)).toBe(true);
  });
});
