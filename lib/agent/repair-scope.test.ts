/**
 * Tests for repair scope: buildRepairScope, isPathInRepairScope.
 * Verifies that repair agent is restricted to files in stack trace, stderr, or command target.
 */

import { describe, it, expect } from "vitest";
import { buildRepairScope, isPathInRepairScope } from "./repair-scope";

describe("buildRepairScope", () => {
  it("extracts paths from stack trace patterns", () => {
    const stderr = `Error: something failed
    at src/app.ts:10:15
    at src/utils/helper.ts:5:1`;
    const scope = buildRepairScope("npm test", stderr, "");
    expect(scope.has("src/app.ts")).toBe(true);
    expect(scope.has("src/utils/helper.ts")).toBe(true);
  });

  it("extracts paths from Python traceback", () => {
    const stderr = `Traceback (most recent call last):
  File "main.py", line 10, in <module>
    foo()`;
    const scope = buildRepairScope("python main.py", stderr, "");
    expect(scope.has("main.py")).toBe(true);
  });

  it("extracts command target from python command", () => {
    const scope = buildRepairScope("python3 src/app.py", "", "");
    expect(scope.has("src/app.py")).toBe(true);
  });

  it("extracts command target from node command", () => {
    const scope = buildRepairScope("node src/index.js", "", "");
    expect(scope.has("src/index.js")).toBe(true);
  });
});

describe("isPathInRepairScope", () => {
  it("returns true when path is in scope", () => {
    const scope = new Set(["src/app.ts", "src/utils/helper.ts"]);
    expect(isPathInRepairScope("src/app.ts", scope)).toBe(true);
    expect(isPathInRepairScope("src/utils/helper.ts", scope)).toBe(true);
  });

  it("returns false when path is not in scope", () => {
    const scope = new Set(["src/app.ts"]);
    expect(isPathInRepairScope("src/unrelated.ts", scope)).toBe(false);
    expect(isPathInRepairScope("lib/other.ts", scope)).toBe(false);
  });

  it("repair cannot modify unrelated file when scope is non-empty", () => {
    const scope = buildRepairScope("npm test", "at src/app.ts:10", "");
    expect(isPathInRepairScope("src/app.ts", scope)).toBe(true);
    expect(isPathInRepairScope("src/unrelated.ts", scope)).toBe(false);
  });

  it("adds failingFile to scope when stderr is empty (prevents false REPAIR_SCOPE_VIOLATION)", () => {
    const scope = buildRepairScope("npm test", "", "", { failingFile: "src/app.test.ts" });
    expect(scope.has("src/app.test.ts")).toBe(true);
    expect(isPathInRepairScope("src/app.test.ts", scope)).toBe(true);
    expect(isPathInRepairScope("src/unrelated.ts", scope)).toBe(false);
  });
});
