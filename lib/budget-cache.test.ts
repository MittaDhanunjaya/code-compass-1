/**
 * Phase 4: Redis shadow cache for budget - fallback when Redis unavailable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isBudgetExhaustedCached, setBudgetExhaustedCache } from "./budget-cache";

describe("budget-cache", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.REDIS_URL;
  });

  it("returns false when REDIS_URL not set (fallback to Supabase)", async () => {
    const exhausted = await isBudgetExhaustedCached("user-1", "2025-02-12", "user");
    expect(exhausted).toBe(false);
  });

  it("returns false when REDIS_URL not set for workspace scope", async () => {
    const exhausted = await isBudgetExhaustedCached("user-1", "2025-02-12", "workspace", "ws-1");
    expect(exhausted).toBe(false);
  });

  it("setBudgetExhaustedCache does not throw when Redis unavailable", async () => {
    await expect(
      setBudgetExhaustedCache("user-1", "2025-02-12", "user")
    ).resolves.toBeUndefined();
  });
});
