/**
 * Tests for code beautifier utility.
 */

import { describe, it, expect } from "vitest";
import { beautifyCode, detectFileType } from "../code-beautifier";

describe("Code Beautifier", () => {
  describe("beautifyCode", () => {
    it("should convert escaped newlines to actual newlines", () => {
      const input = "const x = 1;\\nconst y = 2;";
      const result = beautifyCode(input);
      expect(result).toBe("const x = 1;\nconst y = 2;\n");
    });

    it("should convert escaped tabs to actual tabs", () => {
      const input = "function test() {\\n\\treturn true;\\n}";
      const result = beautifyCode(input);
      expect(result).toBe("function test() {\n\treturn true;\n}\n");
    });

    it("should handle multiple escaped sequences", () => {
      const input = "line1\\nline2\\nline3";
      const result = beautifyCode(input);
      expect(result).toBe("line1\nline2\nline3\n");
    });

    it("should preserve actual newlines", () => {
      const input = "line1\nline2\nline3";
      const result = beautifyCode(input);
      expect(result).toBe("line1\nline2\nline3\n");
    });

    it("should handle mixed escaped and actual newlines", () => {
      const input = "line1\\nline2\nline3";
      const result = beautifyCode(input);
      expect(result).toBe("line1\nline2\nline3\n");
    });

    it("should handle escaped quotes", () => {
      const input = 'const str = "Hello\\"World";';
      const result = beautifyCode(input);
      expect(result).toBe('const str = "Hello"World";\n');
    });

    it("should handle Windows line endings", () => {
      const input = "line1\\r\\nline2";
      const result = beautifyCode(input);
      expect(result).toBe("line1\nline2\n");
    });

    it("should remove trailing whitespace", () => {
      const input = "line1   \\nline2   ";
      const result = beautifyCode(input);
      expect(result).toBe("line1\nline2\n");
    });

    it("should add trailing newline if missing", () => {
      const input = "const x = 1;";
      const result = beautifyCode(input);
      expect(result).toBe("const x = 1;\n");
    });

    it("should preserve empty content", () => {
      const input = "";
      const result = beautifyCode(input);
      expect(result).toBe("");
    });

    it("should handle real-world example from user", () => {
      const input = "const express = require('express');\\nconst path = require('path');\\nconst axios = require('axios');";
      const result = beautifyCode(input);
      expect(result).toBe("const express = require('express');\nconst path = require('path');\nconst axios = require('axios');\n");
    });

    it("should handle complex JavaScript code", () => {
      const input = "function test() {\\n  console.log('hello');\\n  return true;\\n}";
      const result = beautifyCode(input);
      expect(result).toBe("function test() {\n  console.log('hello');\n  return true;\n}\n");
    });
  });

  describe("detectFileType", () => {
    it("should detect JavaScript files", () => {
      expect(detectFileType("test.js")).toBe("javascript");
      expect(detectFileType("test.jsx")).toBe("javascript");
      expect(detectFileType("test.mjs")).toBe("javascript");
    });

    it("should detect TypeScript files", () => {
      expect(detectFileType("test.ts")).toBe("typescript");
      expect(detectFileType("test.tsx")).toBe("typescript");
    });

    it("should detect Python files", () => {
      expect(detectFileType("test.py")).toBe("python");
    });

    it("should detect other file types", () => {
      expect(detectFileType("test.json")).toBe("json");
      expect(detectFileType("test.html")).toBe("html");
      expect(detectFileType("test.css")).toBe("css");
      expect(detectFileType("test.md")).toBe("markdown");
    });

    it("should return 'text' for unknown extensions", () => {
      expect(detectFileType("test.unknown")).toBe("text");
      expect(detectFileType("test")).toBe("text");
    });
  });
});
