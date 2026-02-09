/**
 * Tests for robust JSON parser.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust, extractMultipleJSON } from "../json-parser";

describe("JSON Parser", () => {
  describe("parseJSONRobust", () => {
    it("should parse valid JSON", () => {
      const json = '{"steps": [{"type": "file_edit"}], "summary": "test"}';
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("steps");
      expect(result.data).toHaveProperty("summary", "test");
    });

    it("should parse JSON with markdown code blocks", () => {
      const json = "```json\n{\"steps\": []}\n```";
      const result = parseJSONRobust(json);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("steps");
    });

    it("should handle trailing commas", () => {
      const json = '{"steps": [], "summary": "test",}';
      const result = parseJSONRobust(json);
      expect(result.success).toBe(true);
    });

    it("should handle single quotes", () => {
      const json = "{'steps': [], 'summary': 'test'}";
      const result = parseJSONRobust(json);
      expect(result.success).toBe(true);
    });

    it("should validate required keys", () => {
      const json = '{"summary": "test"}';
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required keys");
    });

    it("should handle malformed JSON gracefully", () => {
      const json = '{"steps": [{"type": "file_edit"';
      const result = parseJSONRobust(json);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("extractMultipleJSON", () => {
    it("should extract multiple JSON objects", () => {
      const content = '{"a": 1} {"b": 2} {"c": 3}';
      const results = extractMultipleJSON(content);
      expect(results.length).toBe(3);
      expect(results[0]).toHaveProperty("a", 1);
      expect(results[1]).toHaveProperty("b", 2);
      expect(results[2]).toHaveProperty("c", 3);
    });
  });
});
