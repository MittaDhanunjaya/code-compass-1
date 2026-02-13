/**
 * Tests for terminal error context normalization.
 */

import { describe, it, expect } from "vitest";
import { normalizeTerminalError } from "./terminal-error-context";

describe("normalizeTerminalError", () => {
  it("normalizes command result into structured object", () => {
    const result = normalizeTerminalError("npm test", {
      exitCode: 1,
      stderr: "Error: test failed",
      stdout: "Running tests...",
    });
    expect(result).toEqual({
      command: "npm test",
      exitCode: 1,
      stderr: "Error: test failed",
      stdout: "Running tests...",
    });
  });

  it("handles null/undefined fields", () => {
    const result = normalizeTerminalError("cmd", {});
    expect(result.command).toBe("cmd");
    expect(result.exitCode).toBe(null);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});
