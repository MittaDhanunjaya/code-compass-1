/**
 * Tests for protected path matching and over-edit checks.
 */
import { describe, it, expect } from "vitest";
import {
  isProtectedPath,
  getProtectedPaths,
  checkOverEdit,
  OVER_EDIT_RATIO_THRESHOLD,
  DEFAULT_PROTECTED_PATTERNS,
} from "./protected-paths";

describe("isProtectedPath", () => {
  describe("basename prefix patterns (.env*)", () => {
    it("matches .env", () => {
      expect(isProtectedPath(".env")).toBe(true);
    });

    it("matches .env.local, .env.production", () => {
      expect(isProtectedPath(".env.local")).toBe(true);
      expect(isProtectedPath(".env.production")).toBe(true);
    });

    it("matches .env in subdirectory", () => {
      expect(isProtectedPath("config/.env.development")).toBe(true);
    });

    it("does not match unrelated files", () => {
      expect(isProtectedPath("src/index.ts")).toBe(false);
      expect(isProtectedPath("env")).toBe(false);
    });
  });

  describe("suffix patterns (*.pem, *.key)", () => {
    it("matches *.pem", () => {
      expect(isProtectedPath("key.pem")).toBe(true);
      expect(isProtectedPath("certs/server.pem")).toBe(true);
    });

    it("matches *.key", () => {
      expect(isProtectedPath("secret.key")).toBe(true);
      expect(isProtectedPath("keys/jwt.key")).toBe(true);
    });

    it("does not match .pem in middle of filename", () => {
      expect(isProtectedPath("file.pem.backup")).toBe(false);
    });
  });

  describe("directory prefix patterns (**)", () => {
    it("matches config/secrets/**", () => {
      expect(isProtectedPath("config/secrets/key")).toBe(true);
      expect(isProtectedPath("config/secrets/nested/key")).toBe(true);
    });

    it("matches .github/workflows/**", () => {
      expect(isProtectedPath(".github/workflows/deploy.yml")).toBe(true);
      expect(isProtectedPath(".github/workflows/ci/test.yml")).toBe(true);
    });

    it("matches infra/**", () => {
      expect(isProtectedPath("infra/terraform/main.tf")).toBe(true);
      expect(isProtectedPath("infra/scripts/setup.sh")).toBe(true);
    });

    it("does not match similar paths outside prefix", () => {
      expect(isProtectedPath("app/config/secrets")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty or whitespace path", () => {
      expect(isProtectedPath("")).toBe(false);
      expect(isProtectedPath("   ")).toBe(false);
    });

    it("respects custom patterns", () => {
      const custom = ["*.secret", "secrets/**"];
      expect(isProtectedPath("db.secret", custom)).toBe(true);
      expect(isProtectedPath("secrets/api.key", custom)).toBe(true);
      expect(isProtectedPath(".env", custom)).toBe(false);
    });
  });
});

describe("getProtectedPaths", () => {
  it("filters to protected paths only", () => {
    const paths = ["src/index.ts", ".env.local", "lib/utils.ts", "config/secrets/api.key"];
    const result = getProtectedPaths(paths);
    expect(result).toEqual([".env.local", "config/secrets/api.key"]);
  });

  it("returns empty array when none match", () => {
    const paths = ["src/a.ts", "lib/b.ts"];
    expect(getProtectedPaths(paths)).toEqual([]);
  });
});

describe("checkOverEdit", () => {
  it("returns overEdit true when replaced ratio exceeds threshold", () => {
    const fileLength = 100;
    const oldContentLength = 50;
    const result = checkOverEdit(fileLength, oldContentLength, 60);
    expect(result.overEdit).toBe(true);
    expect(result.replacedRatio).toBe(0.5);
  });

  it("returns overEdit false when replaced ratio is below threshold", () => {
    const fileLength = 100;
    const oldContentLength = 30;
    const result = checkOverEdit(fileLength, oldContentLength, 40);
    expect(result.overEdit).toBe(false);
    expect(result.replacedRatio).toBe(0.3);
  });

  it("returns overEdit false when exactly at threshold", () => {
    const fileLength = 100;
    const oldContentLength = 40;
    const result = checkOverEdit(fileLength, oldContentLength, 50);
    expect(result.overEdit).toBe(false);
    expect(result.replacedRatio).toBe(OVER_EDIT_RATIO_THRESHOLD);
  });

  it("returns overEdit false for zero-length file", () => {
    const result = checkOverEdit(0, 10, 15);
    expect(result.overEdit).toBe(false);
    expect(result.replacedRatio).toBe(0);
  });
});
