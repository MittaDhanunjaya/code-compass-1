/**
 * Tests for plan lock: execution cannot add new files.
 */

import { describe, it, expect } from "vitest";
import { getAllowedPaths, isPathAllowed, hashPlan } from "./plan-lock";
import type { AgentPlan } from "./types";

describe("getAllowedPaths", () => {
  it("extracts allowed paths from file_edit steps only", () => {
    const plan: AgentPlan = {
      steps: [
        { type: "file_edit", path: "src/a.ts", newContent: "a" },
        { type: "command", command: "npm install" },
        { type: "file_edit", path: "src/b.ts", newContent: "b" },
      ],
    };
    const allowed = getAllowedPaths(plan);
    expect(allowed.has("src/a.ts")).toBe(true);
    expect(allowed.has("src/b.ts")).toBe(true);
    expect(allowed.size).toBe(2);
  });
});

describe("isPathAllowed", () => {
  it("allows path in plan", () => {
    const allowed = new Set(["src/a.ts"]);

    const result = isPathAllowed("src/a.ts", allowed);
    expect(result.allowed).toBe(true);
  });

  it("rejects path not in plan", () => {
    const allowed = new Set(["src/a.ts"]);

    const result = isPathAllowed("src/extra.ts", allowed);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toMatch(/not in the approved plan/i);
    }
  });
});

describe("hashPlan", () => {
  it("identical prompt yields identical file list structure (ignoring ordering)", () => {
    const plan1: AgentPlan = {
      steps: [
        { type: "file_edit", path: "a.ts", newContent: "x" },
        { type: "file_edit", path: "b.ts", newContent: "y" },
      ],
    };
    const plan2: AgentPlan = {
      steps: [
        { type: "file_edit", path: "b.ts", newContent: "y" },
        { type: "file_edit", path: "a.ts", newContent: "x" },
      ],
    };
    const h1 = hashPlan(plan1);
    const h2 = hashPlan(plan2);
    expect(h1).toBe(h2);
  });

  it("different paths produce different hash", () => {
    const p1: AgentPlan = { steps: [{ type: "file_edit", path: "a.ts", newContent: "x" }] };
    const p2: AgentPlan = { steps: [{ type: "file_edit", path: "b.ts", newContent: "x" }] };
    expect(hashPlan(p1)).not.toBe(hashPlan(p2));
  });
});
