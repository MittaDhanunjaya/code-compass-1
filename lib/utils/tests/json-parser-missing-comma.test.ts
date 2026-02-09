/**
 * Tests for missing comma handling in JSON parser.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Missing Comma Handling", () => {
  it("should handle missing comma between properties", () => {
    const json = '{"steps": [] "summary": "test"}';
    const result = parseJSONRobust(json);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(result.data).toHaveProperty("summary", "test");
  });

  it("should handle missing comma after closing brace", () => {
    const json = '{"steps": [{"type": "file_edit"}] "summary": "test"}';
    const result = parseJSONRobust(json);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
  });

  it("should handle complex nested missing commas", () => {
    const json = `{
      "steps": [
        {
          "type": "file_edit",
          "path": "test.ts"
        }
      ]
      "summary": "test"
    }`;
    const result = parseJSONRobust(json, ["steps"]);
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("steps");
    expect(result.data).toHaveProperty("summary");
  });
});
