/**
 * Phase 4: Provider usage reconciliation tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileBudgetWithUsage } from "./budget-reconciliation";

vi.mock("./budget-guard", () => ({
  refundBudget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/metrics", () => ({
  recordReconciliationDrift: vi.fn(),
  recordReconciliationChargeFailure: vi.fn(),
}));

describe("reconcileBudgetWithUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refunds when actual < reserved", async () => {
    const supabase = { rpc: vi.fn() } as never;
    const { refundBudget } = await import("./budget-guard");

    const result = await reconcileBudgetWithUsage(
      supabase as never,
      "user-1",
      1000,
      300,
      "ws-1"
    );

    expect(result).toEqual({
      reserved: 1000,
      actual: 300,
      refunded: 700,
      charged: 0,
      drift: -700,
    });
    expect(refundBudget).toHaveBeenCalledWith(supabase, "user-1", 700, "ws-1");
  });

  it("charges when actual > reserved", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ error: null }),
    } as never;

    const result = await reconcileBudgetWithUsage(
      supabase as never,
      "user-1",
      500,
      800,
      "ws-1"
    );

    expect(result).toEqual({
      reserved: 500,
      actual: 800,
      refunded: 0,
      charged: 300,
      drift: 300,
    });
    expect(supabase.rpc).toHaveBeenCalledWith("charge_additional_tokens", {
      p_user_id: "user-1",
      p_tokens: 300,
      p_workspace_id: "ws-1",
      p_date: new Date().toISOString().slice(0, 10),
    });
  });

  it("does nothing when actual === reserved", async () => {
    const supabase = { rpc: vi.fn() } as never;
    const { refundBudget } = await import("./budget-guard");

    const result = await reconcileBudgetWithUsage(
      supabase as never,
      "user-1",
      1000,
      1000,
      null
    );

    expect(result).toEqual({
      reserved: 1000,
      actual: 1000,
      refunded: 0,
      charged: 0,
      drift: 0,
    });
    expect(refundBudget).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("records charge failure when charge_additional_tokens RPC fails", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ error: { message: "DB error" } }),
    } as never;
    const { recordReconciliationChargeFailure } = await import("@/lib/metrics");

    const result = await reconcileBudgetWithUsage(
      supabase as never,
      "user-1",
      100,
      500,
      null
    );

    expect(result.charged).toBe(400);
    expect(recordReconciliationChargeFailure).toHaveBeenCalled();
  });
});
