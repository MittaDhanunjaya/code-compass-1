/**
 * Tests for plan normalization (deterministic mode).
 * Same plan → identical normalized output and hash.
 */

import { describe, it, expect } from "vitest";
import { normalizePlanForDeterministic } from "./plan-normalizer";

describe("normalizePlanForDeterministic", () => {
  it("same plan twice yields identical normalized output and hash", () => {
    const plan = {
      steps: [
        { type: "command" as const, command: "npm test" },
        { type: "file_edit" as const, path: "src/b.ts", newContent: "b" },
        { type: "file_edit" as const, path: "src/a.ts", newContent: "a" },
      ],
      summary: "Test",
    };
    const r1 = normalizePlanForDeterministic(plan);
    const r2 = normalizePlanForDeterministic(plan);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(JSON.stringify(r1.plan)).toBe(JSON.stringify(r2.plan));
      expect(r1.planHash).toBe(r2.planHash);
    }
  });

  it("sorts file steps by path", () => {
    const plan = {
      steps: [
        { type: "file_edit" as const, path: "src/z.ts", newContent: "z" },
        { type: "file_edit" as const, path: "src/a.ts", newContent: "a" },
      ],
      summary: "Test",
    };
    const r = normalizePlanForDeterministic(plan);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.steps[0].path).toBe("src/a.ts");
      expect(r.plan.steps[1].path).toBe("src/z.ts");
    }
  });

  it("rejects paths exceeding max depth", () => {
    const plan = {
      steps: [
        { type: "file_edit" as const, path: "a/b/c/d/file.ts", newContent: "x" },
      ],
      summary: "Test",
    };
    const r = normalizePlanForDeterministic(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max depth");
  });
});
