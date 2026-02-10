/**
 * Tests for debug-from-log: path extraction, log preprocessing, and stack normalization.
 * Ensures error log parsing works for JS/TS and Python stack traces and various formats.
 */

import { describe, it, expect } from "vitest";
import {
  extractPathsAndLines,
  normalizeStackLog,
  preprocessLog,
} from "./debug-from-log-core";

describe("extractPathsAndLines", () => {
  it("extracts paths and lines from JavaScript/Node stack traces", () => {
    const log = `
Error: Cannot read property 'x' of undefined
    at Component (src/components/Button.tsx:42:15)
    at App (app/page.tsx:10:5)
`;
    const result = extractPathsAndLines(log);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const paths = result.map((r) => r.path);
    expect(paths.some((p) => p.includes("Button") || p.includes("page"))).toBe(true);
    const withLine = result.find((r) => r.line != null);
    expect(withLine?.line).toBeGreaterThanOrEqual(1);
  });

  it("extracts paths from at file:line:column style", () => {
    const log = ` at Object.<anonymous> (lib/utils/helper.js:12:8)`;
    const result = extractPathsAndLines(log);
    expect(result.some((r) => r.path.includes("helper") && r.path.endsWith(".js"))).toBe(true);
    expect(result.find((r) => r.path.includes("helper"))?.line).toBe(12);
  });

  it("extracts Python File paths from traceback", () => {
    const log = `
Traceback (most recent call last):
  File "src/main.py", line 28, in run
    foo()
  File "app/services/api.py", line 15, in foo
`;
    const result = extractPathsAndLines(log);
    expect(result.some((r) => r.path.includes("main") && r.path.endsWith(".py"))).toBe(true);
    expect(result.some((r) => r.path.includes("api") && r.path.endsWith(".py"))).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("normalizes backslashes to forward slashes", () => {
    const log = ` at C:\\project\\src\\app\\page.tsx:10:1`;
    const result = extractPathsAndLines(log);
    expect(result.some((r) => !r.path.includes("\\"))).toBe(true);
  });

  it("deduplicates same path across log", () => {
    const log = `
 at src/foo.ts:1
 at src/foo.ts:2
 at src/foo.ts:3
`;
    const result = extractPathsAndLines(log);
    const fooEntries = result.filter((r) => r.path.includes("foo"));
    expect(fooEntries.length).toBe(1);
  });

  it("returns empty array for log with no file paths", () => {
    const log = "Something went wrong\nNo stack trace here";
    const result = extractPathsAndLines(log);
    expect(result).toEqual([]);
  });
});

describe("normalizeStackLog", () => {
  it("deduplicates similar stack lines", () => {
    const raw = [
      "    at foo (src/a.ts:1:1)",
      "    at foo (src/a.ts:1:1)",
      "    at bar (src/b.ts:2:2)",
    ].join("\n");
    const out = normalizeStackLog(raw);
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("strips at/line prefix noise", () => {
    const raw = "    at Component (src/App.tsx:10:5)";
    const out = normalizeStackLog(raw);
    expect(out).toContain("Component");
    expect(out).toContain("App");
  });
});

describe("preprocessLog", () => {
  it("detects error type from common JS errors", () => {
    const { errorType } = preprocessLog("TypeError: Cannot read property 'x' of undefined");
    expect(errorType).toBe("TypeError");
  });

  it("detects error type from Python errors", () => {
    const { errorType } = preprocessLog("AttributeError: 'NoneType' object has no attribute 'get'");
    expect(errorType).toContain("AttributeError");
  });

  it("extracts top frame file and line", () => {
    const log = `
Error: fail
    at handler (lib/api/route.ts:42:10)
`;
    const { topFrame } = preprocessLog(log);
    expect(topFrame).not.toBeNull();
    expect(topFrame?.file).toMatch(/route\.ts$/);
    expect(topFrame?.line).toBe(42);
  });

  it("extracts route or command when present", () => {
    const withRoute = preprocessLog("GET /api/workspaces/123 failed");
    expect(withRoute.routeOrCommand).toContain("api/workspaces");
    const withCmd = preprocessLog("npm run build failed");
    expect(withCmd.routeOrCommand).toMatch(/npm/);
  });

  it("returns normalized log without markdown/code blocks", () => {
    const log = "  at foo (a.ts:1:1)  \n  at bar (b.ts:2:2)  ";
    const { normalizedLog } = preprocessLog(log);
    expect(normalizedLog.length).toBeGreaterThan(0);
    expect(normalizedLog).not.toMatch(/^\s*$/);
  });
});
