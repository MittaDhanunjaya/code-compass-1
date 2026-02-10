/**
 * Tests for workspace file validation (large project creation limits).
 */

import { describe, it, expect } from "vitest";
import {
  validateLocalFiles,
  MAX_LOCAL_FILES,
  MAX_FILE_SIZE,
} from "./validate-workspace-files";

describe("validateLocalFiles", () => {
  it("accepts up to MAX_LOCAL_FILES valid files", () => {
    const files = Array.from({ length: MAX_LOCAL_FILES }, (_, i) => ({
      path: `src/file${i}.ts`,
      content: "x",
    }));
    const result = validateLocalFiles(files);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(MAX_LOCAL_FILES);
  });

  it("rejects more than MAX_LOCAL_FILES", () => {
    const files = Array.from({ length: MAX_LOCAL_FILES + 1 }, (_, i) => ({
      path: `src/file${i}.ts`,
      content: "",
    }));
    const result = validateLocalFiles(files);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Too many files");
      expect(result.error).toContain(String(MAX_LOCAL_FILES));
    }
  });

  it("rejects non-array input", () => {
    expect(validateLocalFiles(null).ok).toBe(false);
    expect(validateLocalFiles(undefined).ok).toBe(false);
    expect(validateLocalFiles("files").ok).toBe(false);
    expect(validateLocalFiles({}).ok).toBe(false);
  });

  it("ignores entries without valid path", () => {
    const result = validateLocalFiles([
      { path: "a.ts", content: "" },
      { path: "  ", content: "" },
      { path: "", content: "" },
      {},
      { path: "b.ts" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(2);
  });

  it("counts all entries with valid path regardless of content size", () => {
    const result = validateLocalFiles([
      { path: "a.ts", content: "small" },
      { path: "b.ts", content: "x".repeat(MAX_FILE_SIZE + 1) },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(2);
  });

  it("uses MAX_FILE_SIZE constant as documented limit", () => {
    expect(MAX_FILE_SIZE).toBe(500_000);
  });

  it("uses MAX_LOCAL_FILES constant as documented limit", () => {
    expect(MAX_LOCAL_FILES).toBe(500);
  });
});
