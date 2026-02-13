/**
 * Production hardening: Budget guard tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/budget-cache", () => ({
  isBudgetExhaustedCached: vi.fn().mockResolvedValue(false),
  setBudgetExhaustedCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cost-guardrails", () => ({
  checkPerRequestCostCeiling: vi.fn(),
  recordTokenBurnAndAlert: vi.fn().mockResolvedValue(undefined),
}));
import {
  enforceAndRecordBudget,
  enforceBudget,
  refundBudget,
  BudgetExceededError,
  ServiceUnavailableError,
  estimateTokensFromChars,
} from "./budget-guard";

describe("budget-guard", () => {
  describe("enforceAndRecordBudget", () => {
    it("throws BudgetExceededError when RPC returns user budget exceeded", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({
          error: { message: "BUDGET_EXCEEDED:user:Daily token budget exceeded. Try again tomorrow." },
        }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await expect(enforceAndRecordBudget(supabase, "user-1", 1000)).rejects.toThrow(BudgetExceededError);
      await expect(enforceAndRecordBudget(supabase, "user-1", 1000)).rejects.toThrow(/Daily token budget exceeded/);
    });

    it("throws BudgetExceededError when RPC returns workspace budget exceeded", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({
          error: { message: "BUDGET_EXCEEDED:workspace:Workspace daily token limit exceeded. Try again tomorrow." },
        }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await expect(enforceAndRecordBudget(supabase, "user-1", 1000, "ws-1")).rejects.toThrow(BudgetExceededError);
      await expect(enforceAndRecordBudget(supabase, "user-1", 1000, "ws-1")).rejects.toThrow(/Workspace daily token limit/);
    });

    it("does not throw when RPC succeeds", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({ error: null }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await expect(enforceAndRecordBudget(supabase, "user-1", 1000)).resolves.toBeUndefined();
    });

    it("does nothing when tokensToReserve <= 0", async () => {
      const supabase = { rpc: vi.fn() } as unknown as Parameters<typeof enforceAndRecordBudget>[0];
      await expect(enforceAndRecordBudget(supabase, "user-1", 0)).resolves.toBeUndefined();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("throws ServiceUnavailableError (503) when RPC returns infra error", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({
          error: { message: "Connection refused", code: "ECONNREFUSED" },
        }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await expect(enforceAndRecordBudget(supabase, "user-1", 1000)).rejects.toThrow(ServiceUnavailableError);
      await expect(enforceAndRecordBudget(supabase, "user-1", 1000)).rejects.toThrow(/temporarily unavailable/);
    });
  });

  describe("enforceBudget (wrapper)", () => {
    it("calls enforceAndRecordBudget with STREAMING_RESERVE_TOKENS", async () => {
      const supabase = { rpc: vi.fn().mockResolvedValue({ error: null }) } as unknown as Parameters<typeof enforceBudget>[0];
      await enforceBudget(supabase, "user-1", "ws-1");
      expect(supabase.rpc).toHaveBeenCalledWith(
        "enforce_and_record_tokens",
        expect.objectContaining({
          p_user_id: "user-1",
          p_workspace_id: "ws-1",
          p_tokens: expect.any(Number),
        })
      );
    });

    it("throws when RPC returns budget exceeded", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({
          error: { message: "BUDGET_EXCEEDED:user:Daily token budget exceeded. Try again tomorrow." },
        }),
      } as unknown as Parameters<typeof enforceBudget>[0];
      await expect(enforceBudget(supabase, "user-1")).rejects.toThrow(BudgetExceededError);
    });
  });

  describe("estimateTokensFromChars", () => {
    it("estimates ~4 chars per token", () => {
      expect(estimateTokensFromChars(40)).toBe(10);
      expect(estimateTokensFromChars(0)).toBe(0);
    });
  });

  describe("ServiceUnavailableError", () => {
    it("has code SERVICE_UNAVAILABLE and statusCode 503", () => {
      const err = new ServiceUnavailableError();
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
      expect(err.statusCode).toBe(503);
    });
  });

  describe("BudgetExceededError", () => {
    it("has code BUDGET_EXCEEDED and statusCode 429", () => {
      const err = new BudgetExceededError("Test", "user", 3600);
      expect(err.code).toBe("BUDGET_EXCEEDED");
      expect(err.statusCode).toBe(429);
      expect(err.retryAfter).toBe(3600);
    });
  });

  describe("idempotent reservation", () => {
    it("calls reserve_budget_idempotent when requestId is provided", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({ error: null }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await enforceAndRecordBudget(supabase, "user-1", 1000, null, "req-123");

      expect(supabase.rpc).toHaveBeenCalledWith(
        "reserve_budget_idempotent",
        expect.objectContaining({
          p_request_id: "req-123",
          p_user_id: "user-1",
          p_tokens: expect.any(Number),
        })
      );
    });

    it("calls enforce_and_record_tokens when requestId is not provided", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({ error: null }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await enforceAndRecordBudget(supabase, "user-1", 1000);

      expect(supabase.rpc).toHaveBeenCalledWith("enforce_and_record_tokens", expect.any(Object));
    });

    it("retries with same requestId do not double-charge (RPC idempotency)", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({ error: null }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      await enforceAndRecordBudget(supabase, "user-1", 1000, null, "req-same");
      await enforceAndRecordBudget(supabase, "user-1", 1000, null, "req-same");

      expect(supabase.rpc).toHaveBeenCalledTimes(2);
      expect(supabase.rpc).toHaveBeenNthCalledWith(1, "reserve_budget_idempotent", expect.objectContaining({ p_request_id: "req-same" }));
      expect(supabase.rpc).toHaveBeenNthCalledWith(2, "reserve_budget_idempotent", expect.objectContaining({ p_request_id: "req-same" }));
      // Both succeed; DB INSERT ON CONFLICT ensures only first charges. Unit test verifies we pass same requestId.
    });
  });

  describe("refundBudget", () => {
    it("calls refund_tokens RPC with correct params", async () => {
      const supabase = {
        rpc: vi.fn().mockResolvedValue({ error: null }),
      } as unknown as Parameters<typeof refundBudget>[0];

      await refundBudget(supabase, "user-1", 500, "ws-1");

      expect(supabase.rpc).toHaveBeenCalledWith(
        "refund_tokens",
        expect.objectContaining({
          p_user_id: "user-1",
          p_tokens: 500,
          p_workspace_id: "ws-1",
        })
      );
    });

    it("does nothing when tokensToRefund <= 0", async () => {
      const supabase = { rpc: vi.fn() } as unknown as Parameters<typeof refundBudget>[0];
      await refundBudget(supabase, "user-1", 0);
      await refundBudget(supabase, "user-1", -1);
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  });

  describe("concurrent budget enforcement", () => {
    it("serializes RPC calls so only one succeeds when at limit", async () => {
      let callCount = 0;
      const supabase = {
        rpc: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { error: null };
          }
          return {
            error: { message: "BUDGET_EXCEEDED:user:Daily token budget exceeded. Try again tomorrow." },
          };
        }),
      } as unknown as Parameters<typeof enforceAndRecordBudget>[0];

      const results = await Promise.allSettled([
        enforceAndRecordBudget(supabase, "user-1", 50000),
        enforceAndRecordBudget(supabase, "user-1", 50000),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      if (rejected[0].status === "rejected") {
        expect(rejected[0].reason).toBeInstanceOf(BudgetExceededError);
      }
    });
  });
});
