import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPreflightChecks } from "./index";

describe("preflight", () => {
  const origEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  it("runs all checks and returns structured result", async () => {
    const result = await runPreflightChecks();
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("checks");
    expect(Array.isArray(result.checks)).toBe(true);
    const names = result.checks.map((c) => c.name);
    expect(names).toContain("models");
    expect(names).toContain("streaming");
    expect(names).toContain("formatter");
    expect(names).toContain("port");
    expect(names).toContain("error_events");
    expect(names).toContain("budget");
  });

  it("models check passes when catalog has models", async () => {
    const result = await runPreflightChecks();
    const modelsCheck = result.checks.find((c) => c.name === "models");
    expect(modelsCheck?.ok).toBe(true);
  });

  it("formatter check passes", async () => {
    const result = await runPreflightChecks();
    const formatterCheck = result.checks.find((c) => c.name === "formatter");
    expect(formatterCheck?.ok).toBe(true);
  });

  it("budget check passes", async () => {
    const result = await runPreflightChecks();
    const budgetCheck = result.checks.find((c) => c.name === "budget");
    expect(budgetCheck?.ok).toBe(true);
  });
});
