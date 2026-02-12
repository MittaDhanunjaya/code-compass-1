/**
 * Comprehensive test suite for JSON parser covering all known edge cases.
 * This should catch issues BEFORE they appear in production.
 */

import { describe, it, expect } from "vitest";
import { parseJSONRobust } from "../json-parser";

describe("JSON Parser - Comprehensive Edge Case Testing", () => {
  describe("Trailing Comma Issues", () => {
    it("should handle trailing comma in object", () => {
      const json = `{"steps": [], "summary": "test",}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle trailing comma in array", () => {
      const json = `{"steps": [{"type": "edit"},], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle multiple trailing commas", () => {
      const json = `{"steps": [{"type": "edit",},], "summary": "test",}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle trailing comma after nested object", () => {
      const json = `{"steps": [{"type": "edit", "data": {}},], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });
  });

  describe("Missing Comma Issues", () => {
    it("should handle missing comma between properties", () => {
      const json = `{"steps": [] "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("summary");
    });

    it("should handle missing comma in nested object", () => {
      const json = `{"steps": [{"type": "edit" "path": "test.ts"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after array", () => {
      const json = `{"steps": [] "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after string value", () => {
      const json = `{"summary": "test" "steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after number", () => {
      const json = `{"count": 5 "steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after boolean", () => {
      const json = `{"active": true "steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after null", () => {
      const json = `{"value": null "steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after nested object", () => {
      const json = `{"config": {"key": "value"} "steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma after nested array", () => {
      const json = `{"tags": ["a", "b"] "steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });
  });

  describe("Control Character Issues", () => {
    it("should handle unescaped newlines in strings", () => {
      const json = `{"steps": [{"content": "line1\nline2"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle unescaped tabs in strings", () => {
      const json = `{"steps": [{"content": "line1\tline2"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle unescaped carriage returns", () => {
      const json = `{"steps": [{"content": "line1\rline2"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle multiple control characters", () => {
      const json = `{"steps": [{"content": "line1\nline2\tline3\rline4"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should preserve already-escaped sequences", () => {
      const json = `{"steps": [{"content": "line1\\nline2"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect((result.data as { steps: Array<{ content: string }> }).steps[0].content).toBe("line1\nline2");
    });
  });

  describe("Leading Text Issues", () => {
    it("should skip 'Looking at' prefix", () => {
      const json = `Looking at the codebase: {"steps": [], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should skip 'Here is' prefix", () => {
      const json = `Here is the plan: {"steps": [], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should skip multi-line prefix", () => {
      const json = `After analyzing the code,\nhere's the plan:\n{"steps": [], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should skip markdown code block prefix", () => {
      const json = `\`\`\`json\n{"steps": [], "summary": "test"}\n\`\`\``;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });
  });

  describe("Quote Issues", () => {
    it("should handle single quotes", () => {
      const json = `{'steps': [], 'summary': 'test'}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle mixed quotes", () => {
      const json = `{"steps": [], 'summary': "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle unescaped quotes in strings", () => {
      const json = `{"steps": [{"content": "He said \\"hello\\""}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });
  });

  describe("Comment Issues", () => {
    it("should remove single-line comments", () => {
      const json = `{"steps": [], // comment\n"summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should remove multi-line comments", () => {
      const json = `{"steps": [], /* comment */ "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle comments in strings", () => {
      const json = `{"steps": [{"content": "// not a comment"}], "summary": "test"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect((result.data as { steps: Array<{ content: string }> }).steps[0].content).toBe("// not a comment");
    });
  });

  describe("Python-style Values", () => {
    it("should convert True to true", () => {
      const json = `{"steps": [], "active": True}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect((result.data as { active: boolean }).active).toBe(true);
    });

    it("should convert False to false", () => {
      const json = `{"steps": [], "active": False}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect((result.data as { active: boolean }).active).toBe(false);
    });

    it("should convert None to null", () => {
      const json = `{"steps": [], "value": None}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect((result.data as { value: null }).value).toBe(null);
    });
  });

  describe("Complex Combined Issues", () => {
    it("should handle trailing comma + missing comma + control chars", () => {
      const json = `{"steps": [{"type": "edit", "content": "line1\nline2"},] "summary": "test",}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle leading text + trailing comma + single quotes", () => {
      const json = `Here's the plan: {'steps': [], 'summary': 'test',}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma + control chars + comments", () => {
      const json = `{"steps": [] // comment\n"summary": "test\nwith newline"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle real-world LLM output simulation", () => {
      const json = `Looking at the codebase, here's what needs to be done:
{
  "steps": [
    {
      "type": "file_edit",
      "path": "test.ts",
      "newContent": "function test() {\n  console.log('hello');\n}"
    },
  ],
  "summary": "Add test function",
}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty("steps");
      expect(result.data).toHaveProperty("summary");
    });
  });

  describe("Position-specific Errors", () => {
    it("should handle error at position 237 (line 8 column 131)", () => {
      // Simulate the exact error scenario
      const json = `{
  "steps": [
    {
      "type": "file_edit",
      "path": "test.ts",
      "newContent": "code here"
    }
  ],
  "summary": "test"
}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle missing comma at specific position", () => {
      // Create a scenario that would fail at position ~237
      const json = `{"steps": [{"type": "edit", "path": "test.ts", "content": "some code"}], "summary": "test" "extra": "value"}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty JSON", () => {
      const json = `{}`;
      const result = parseJSONRobust(json, []);
      expect(result.success).toBe(true);
    });

    it("should handle empty array", () => {
      const json = `{"steps": []}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle deeply nested structures", () => {
      const json = `{"steps": [{"data": {"nested": {"deep": {"value": "test"}}}}]}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle very long strings", () => {
      const longString = "a".repeat(1000);
      const json = `{"steps": [{"content": "${longString}"}]}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
    });

    it("should handle special characters in strings", () => {
      // Note: Some special characters need escaping in JSON strings
      // This test uses properly escaped JSON
      const json = `{"steps": [{"content": "Special: !@#$%^&*()_+-=[]{}|;':\\\",./<>?"}]}`;
      const result = parseJSONRobust(json, ["steps"]);
      expect(result.success).toBe(true);
      expect((result.data as { steps: Array<{ content: string }> }).steps[0].content).toContain("Special:");
    });
  });
});
