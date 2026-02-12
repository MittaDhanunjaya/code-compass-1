/**
 * Phase 3.4.4: Unit tests for tool registry validation.
 */

import { describe, it, expect } from "vitest";
import {
  isRegisteredTool,
  validateToolName,
  getTool,
  validateToolInput,
  getToolTimeoutMs,
  REGISTERED_TOOL_NAMES,
} from "./registry";

describe("tool registry", () => {
  describe("isRegisteredTool", () => {
    it("returns true for registered tools", () => {
      expect(isRegisteredTool("read_file")).toBe(true);
      expect(isRegisteredTool("edit_file")).toBe(true);
      expect(isRegisteredTool("run_command")).toBe(true);
      expect(isRegisteredTool("search_index")).toBe(true);
    });

    it("returns false for unknown tools", () => {
      expect(isRegisteredTool("hallucinated_tool")).toBe(false);
      expect(isRegisteredTool("")).toBe(false);
    });
  });

  describe("validateToolName", () => {
    it("does not throw for registered tools", () => {
      expect(() => validateToolName("read_file")).not.toThrow();
      expect(() => validateToolName("run_command")).not.toThrow();
    });

    it("throws for unknown tools", () => {
      expect(() => validateToolName("fake_tool")).toThrow(/Unknown tool/);
      expect(() => validateToolName("fake_tool")).toThrow(/fake_tool/);
    });
  });

  describe("getTool", () => {
    it("returns tool def for registered tools", () => {
      const def = getTool("read_file");
      expect(def).not.toBeNull();
      expect(def?.name).toBe("read_file");
      expect(def?.inputSchema).toBeDefined();
      expect(def?.permissions).toContain("read");
    });

    it("returns null for unknown tools", () => {
      expect(getTool("unknown")).toBeNull();
    });
  });

  describe("validateToolInput", () => {
    it("validates read_file input", () => {
      const result = validateToolInput<{ path: string }>("read_file", { path: "src/app.ts" });
      expect(result.path).toBe("src/app.ts");
    });

    it("rejects read_file with empty path", () => {
      expect(() => validateToolInput("read_file", { path: "" })).toThrow();
    });

    it("validates edit_file input", () => {
      const result = validateToolInput<{ path: string; newContent: string }>("edit_file", {
        path: "a.ts",
        newContent: "x",
      });
      expect(result.path).toBe("a.ts");
      expect(result.newContent).toBe("x");
    });

    it("rejects edit_file without newContent", () => {
      expect(() => validateToolInput("edit_file", { path: "a.ts" })).toThrow();
    });

    it("validates run_command input", () => {
      const result = validateToolInput<{ command: string }>("run_command", { command: "npm test" });
      expect(result.command).toBe("npm test");
    });

    it("rejects run_command with empty command", () => {
      expect(() => validateToolInput("run_command", { command: "" })).toThrow();
    });

    it("validates search_index input", () => {
      const result = validateToolInput("search_index", { query: "test", limit: 10 });
      expect(result.query).toBe("test");
      expect(result.limit).toBe(10);
    });

    it("rejects unknown tool", () => {
      expect(() => validateToolInput("fake", {})).toThrow(/Unknown tool/);
    });
  });

  describe("getToolTimeoutMs", () => {
    it("returns timeout for registered tools", () => {
      expect(getToolTimeoutMs("read_file")).toBe(5_000);
      expect(getToolTimeoutMs("run_command")).toBe(120_000);
    });

    it("throws for unknown tools", () => {
      expect(() => getToolTimeoutMs("fake")).toThrow();
    });
  });

  describe("REGISTERED_TOOL_NAMES", () => {
    it("contains expected tools", () => {
      expect(REGISTERED_TOOL_NAMES).toContain("read_file");
      expect(REGISTERED_TOOL_NAMES).toContain("edit_file");
      expect(REGISTERED_TOOL_NAMES).toContain("run_command");
      expect(REGISTERED_TOOL_NAMES).toContain("search_index");
    });
  });
});
