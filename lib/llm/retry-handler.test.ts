/**
 * Phase 9.1: Tests for LLM retry handler.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { withRetry } from "./retry-handler";

describe("retry-handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const p = withRetry(fn);
    const result = await p;
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("rate limit")).mockResolvedValueOnce(1);
    const p = withRetry(fn, { isRetryable: () => true, maxAttempts: 3 });
    const result = await p;
    expect(result).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max attempts when error is retryable", async () => {
    const err = new Error("always fails");
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry(fn, { isRetryable: () => true, maxAttempts: 3 });
    await expect(p).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when error is not retryable", async () => {
    const err = new Error("validation error");
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry(fn, { isRetryable: () => false });
    await expect(p).rejects.toThrow("validation error");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
