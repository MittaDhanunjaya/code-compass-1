/**
 * Tests for path sanitization (Phase 10.3).
 */

import { describe, it, expect } from "vitest";
import { sanitizePath } from "./sanitize-path";

describe("sanitizePath", () => {
  it("accepts valid relative paths", () => {
    expect(sanitizePath("src/file.ts").ok).toBe(true);
    if (sanitizePath("src/file.ts").ok) expect(sanitizePath("src/file.ts").path).toBe("src/file.ts");

    expect(sanitizePath("  a/b/c  ").ok).toBe(true);
    if (sanitizePath("  a/b/c  ").ok) expect(sanitizePath("  a/b/c  ").path).toBe("a/b/c");

    expect(sanitizePath("package.json").ok).toBe(true);
  });

  it("rejects path traversal", () => {
    const r1 = sanitizePath("../etc/passwd");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("traversal");

    const r2 = sanitizePath("a/../b");
    expect(r2.ok).toBe(false);

    const r3 = sanitizePath("a/../../b");
    expect(r3.ok).toBe(false);

    const r4 = sanitizePath("..");
    expect(r4.ok).toBe(false);
  });

  it("rejects absolute paths", () => {
    const r1 = sanitizePath("/etc/passwd");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("Absolute");

    const r2 = sanitizePath("\\Windows\\path");
    expect(r2.ok).toBe(false);

    const r3 = sanitizePath("C:/foo/bar");
    expect(r3.ok).toBe(false);
  });

  it("rejects empty path", () => {
    const r = sanitizePath("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("empty");
  });

  it("normalizes slashes", () => {
    const r = sanitizePath("a\\b\\c");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("a/b/c");
  });
});
