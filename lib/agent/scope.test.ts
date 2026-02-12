/**
 * Phase 9.1.3: Tests for agent scope (computeRunScope, applyScopeCaps).
 */

import { describe, it, expect } from "vitest";
import {
  computeRunScope,
  applyScopeCaps,
  MAX_CONSERVATIVE_FILES,
  MAX_CONSERVATIVE_LINES,
} from "./scope";
import type { FileEditStep, PlanStep } from "./types";

describe("agent/scope", () => {
  describe("computeRunScope", () => {
    it("computes scope from file edit steps", () => {
      const steps: FileEditStep[] = [
        { type: "file_edit", path: "a.ts", newContent: "line1\nline2\nline3" },
        { type: "file_edit", path: "b.ts", newContent: "x", oldContent: "y\ny" },
      ];
      const scope = computeRunScope(steps);
      expect(scope.fileCount).toBe(2);
      expect(scope.approxLinesChanged).toBe(3 + 2);
      expect(scope.perFile).toHaveLength(2);
      expect(scope.perFile[0]).toMatchObject({ path: "a.ts", approxLines: 3 });
      expect(scope.perFile[1]).toMatchObject({ path: "b.ts", approxLines: 2 });
    });

    it("returns empty scope for no steps", () => {
      const scope = computeRunScope([]);
      expect(scope.fileCount).toBe(0);
      expect(scope.approxLinesChanged).toBe(0);
      expect(scope.perFile).toEqual([]);
    });

    it("skips steps with empty path", () => {
      const steps: FileEditStep[] = [
        { type: "file_edit", path: "", newContent: "content" },
      ];
      const scope = computeRunScope(steps);
      expect(scope.fileCount).toBe(0);
    });
  });

  describe("applyScopeCaps", () => {
    it("returns steps unchanged for normal scope", () => {
      const steps: PlanStep[] = [
        { type: "file_edit", path: "a.ts", newContent: "x".repeat(100) },
        { type: "file_edit", path: "b.ts", newContent: "y".repeat(100) },
        { type: "command", command: "npm test" },
      ];
      const result = applyScopeCaps(steps, "normal");
      expect(result.trimmed).toBe(false);
      expect(result.steps).toHaveLength(3);
    });

    it("trims file edits when over conservative limits", () => {
      const steps: PlanStep[] = Array.from({ length: 10 }, (_, i) => ({
        type: "file_edit" as const,
        path: `file${i}.ts`,
        newContent: "line\n".repeat(60),
      }));
      const result = applyScopeCaps(steps, "conservative");
      expect(result.trimmed).toBe(true);
      expect(result.steps.length).toBeLessThanOrEqual(MAX_CONSERVATIVE_FILES);
      const fileEdits = result.steps.filter((s) => s.type === "file_edit");
      expect(fileEdits.length).toBeLessThanOrEqual(MAX_CONSERVATIVE_FILES);
    });

    it("keeps preferred paths first when trimming", () => {
      const preferred = new Set(["preferred.ts"]);
      // Exceed conservative limits: 6 files, each ~60 lines
      const steps: PlanStep[] = [
        { type: "file_edit", path: "other1.ts", newContent: "line\n".repeat(60) },
        { type: "file_edit", path: "preferred.ts", newContent: "line\n".repeat(60) },
        { type: "file_edit", path: "other2.ts", newContent: "line\n".repeat(60) },
        { type: "file_edit", path: "other3.ts", newContent: "line\n".repeat(60) },
        { type: "file_edit", path: "other4.ts", newContent: "line\n".repeat(60) },
        { type: "file_edit", path: "other5.ts", newContent: "line\n".repeat(60) },
      ];
      const result = applyScopeCaps(steps, "conservative", preferred);
      expect(result.trimmed).toBe(true);
      const paths = result.steps
        .filter((s) => s.type === "file_edit")
        .map((s) => (s as FileEditStep).path);
      expect(paths[0]).toBe("preferred.ts");
    });

    it("always keeps command steps", () => {
      const steps: PlanStep[] = [
        ...Array.from({ length: 8 }, (_, i) => ({
          type: "file_edit" as const,
          path: `f${i}.ts`,
          newContent: "x".repeat(100),
        })),
        { type: "command", command: "npm run build" },
      ];
      const result = applyScopeCaps(steps, "conservative");
      const commands = result.steps.filter((s) => s.type === "command");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ command: "npm run build" });
    });
  });
});
