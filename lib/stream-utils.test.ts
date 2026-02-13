/**
 * Production hardening: Streaming edge case tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldStopStream, createStreamAbortSignal, MAX_STREAM_DURATION_MS } from "./stream-utils";

describe("stream-utils", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when request signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request("http://test", { signal: controller.signal });
    const startTime = Date.now();
    expect(shouldStopStream(request, startTime)).toBe(true);
  });

  it("returns true when stream duration exceeds max", () => {
    vi.useFakeTimers();
    const request = new Request("http://test");
    const startTime = Date.now();
    vi.advanceTimersByTime(MAX_STREAM_DURATION_MS + 1000);
    expect(shouldStopStream(request, startTime)).toBe(true);
  });

  it("returns false when within limits", () => {
    const request = new Request("http://test");
    const startTime = Date.now();
    expect(shouldStopStream(request, startTime)).toBe(false);
  });

  it("createStreamAbortSignal fires on timeout (provider hang scenario)", () => {
    vi.useFakeTimers();
    const request = new Request("http://test");
    const signal = createStreamAbortSignal(request, 1000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1100);
    expect(signal.aborted).toBe(true);
  });

  it("createStreamAbortSignal fires on client disconnect", () => {
    const clientController = new AbortController();
    const request = new Request("http://test", { signal: clientController.signal });
    const signal = createStreamAbortSignal(request, 60_000);
    expect(signal.aborted).toBe(false);
    clientController.abort();
    expect(signal.aborted).toBe(true);
  });

  it("createStreamAbortSignal calls onAbort with 'timeout' when timeout fires", () => {
    vi.useFakeTimers();
    const request = new Request("http://test");
    const onAbort = vi.fn();
    const signal = createStreamAbortSignal(request, 1000, onAbort);
    expect(onAbort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1100);
    expect(onAbort).toHaveBeenCalledWith("timeout");
  });

  it("createStreamAbortSignal calls onAbort with 'client' when client disconnects", () => {
    const clientController = new AbortController();
    const request = new Request("http://test", { signal: clientController.signal });
    const onAbort = vi.fn();
    const signal = createStreamAbortSignal(request, 60_000, onAbort);
    expect(onAbort).not.toHaveBeenCalled();
    clientController.abort();
    expect(onAbort).toHaveBeenCalledWith("client");
  });
});
