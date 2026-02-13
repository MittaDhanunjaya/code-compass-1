/**
 * Production hardening: RPC failure classification and fallback exclusion.
 */

import { describe, it, expect } from "vitest";
import {
  classifySupabaseRpcError,
  isInfraFailure,
  isFallbackableError,
  isBudgetExceededError,
  isQuotaExceededError,
} from "./rate-limit";

describe("rate-limit", () => {
  describe("classifySupabaseRpcError", () => {
    it("returns budget_exceeded for BUDGET_EXCEEDED", () => {
      expect(classifySupabaseRpcError(new Error("BUDGET_EXCEEDED:user:Daily token budget exceeded"))).toBe("budget_exceeded");
      expect(classifySupabaseRpcError({ code: "BUDGET_EXCEEDED", message: "x" })).toBe("budget_exceeded");
    });

    it("returns timeout for timeout-like errors", () => {
      expect(classifySupabaseRpcError(new Error("Request timeout"))).toBe("timeout");
      expect(classifySupabaseRpcError(new Error("ETIMEDOUT"))).toBe("timeout");
      expect(classifySupabaseRpcError(new Error("504 Gateway Timeout"))).toBe("timeout");
    });

    it("returns infra for connection/DB errors", () => {
      expect(classifySupabaseRpcError(new Error("Connection refused"))).toBe("infra");
      expect(classifySupabaseRpcError(new Error("some random error"))).toBe("infra");
    });
  });

  describe("isInfraFailure", () => {
    it("returns true for ECONNREFUSED, 500, postgres, etc", () => {
      expect(isInfraFailure({ code: "ECONNREFUSED" })).toBe(true);
      expect(isInfraFailure({ code: "ECONNRESET" })).toBe(true);
      expect(isInfraFailure(new Error("500 Internal Server Error"))).toBe(true);
      expect(isInfraFailure(new Error("Connection refused"))).toBe(true);
      expect(isInfraFailure(new Error("PostgREST error"))).toBe(true);
      expect(isInfraFailure(new Error("supabase connection failed"))).toBe(true);
    });

    it("returns false for budget exceeded", () => {
      expect(isInfraFailure({ code: "BUDGET_EXCEEDED" })).toBe(false);
    });

    it("returns false for 429 and 404 (provider errors)", () => {
      expect(isInfraFailure(new Error("429 Too Many Requests"))).toBe(false);
      expect(isInfraFailure(new Error("404 Not Found"))).toBe(false);
    });
  });

  describe("isFallbackableError", () => {
    it("returns false for budget exceeded", () => {
      expect(isFallbackableError({ code: "BUDGET_EXCEEDED" })).toBe(false);
    });

    it("returns false for infra failures", () => {
      expect(isFallbackableError({ code: "ECONNREFUSED" })).toBe(false);
      expect(isFallbackableError(new Error("500 Internal Server Error"))).toBe(false);
    });

    it("returns true for rate limit, timeout, endpoint not found", () => {
      expect(isFallbackableError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isFallbackableError(new Error("Request timeout"))).toBe(true);
      expect(isFallbackableError(new Error("404 no endpoints found"))).toBe(true);
    });
  });

  describe("isQuotaExceededError", () => {
    it("returns true for 429, quota exceeded, rate limit", () => {
      expect(isQuotaExceededError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isQuotaExceededError(new Error("quota exceeded"))).toBe(true);
      expect(isQuotaExceededError(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    });

    it("returns false for budget exceeded (user limit)", () => {
      expect(isQuotaExceededError({ code: "BUDGET_EXCEEDED" })).toBe(false);
    });
  });

  describe("isQuotaExceededError", () => {
    it("returns true for 429, quota exceeded", () => {
      expect(isQuotaExceededError(new Error("429 Too Many Requests"))).toBe(true);
      expect(isQuotaExceededError(new Error("quota exceeded"))).toBe(true);
    });
  });

  describe("isBudgetExceededError", () => {
    it("returns true for BudgetExceededError", () => {
      expect(isBudgetExceededError({ code: "BUDGET_EXCEEDED" })).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isBudgetExceededError(new Error("500"))).toBe(false);
    });
  });
});
