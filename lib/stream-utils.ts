/**
 * Helpers for ReadableStream controllers so client abort doesn't throw
 * "Controller is already closed" or similar. Use before every enqueue/close.
 * Phase 6.2: Uses STREAMING_CONFIG from constants.
 */

import { STREAMING_CONFIG } from "@/lib/config/constants";
export const STREAM_UPSTREAM_TIMEOUT_MS = STREAMING_CONFIG.STREAM_UPSTREAM_TIMEOUT_MS;
export const MAX_STREAM_DURATION_MS = STREAMING_CONFIG.MAX_STREAM_DURATION_MS;

/** First-token timeout (ms). Abort provider if no token in this window. */
export const STREAM_FIRST_TOKEN_TIMEOUT_MS = 25_000;

/**
 * Merge multiple AbortSignals into one. Aborts when ANY input aborts.
 * Ensures timeout cannot be bypassed by user-provided signal.
 */
export function mergeAbortSignals(signals: (AbortSignal | null | undefined)[]): AbortSignal {
  const controller = new AbortController();
  const clean = signals.filter((s): s is AbortSignal => s != null && !s.aborted);
  if (clean.length === 0) return controller.signal;
  for (const s of clean) {
    if (s.aborted) {
      controller.abort();
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** Check if we should stop streaming (client disconnected or timeout). */
export function shouldStopStream(request: Request, startTime: number, timeoutMs: number = STREAM_UPSTREAM_TIMEOUT_MS): boolean {
  if (request.signal?.aborted) return true;
  if (Date.now() - startTime > MAX_STREAM_DURATION_MS) return true;
  return Date.now() - startTime > timeoutMs;
}

/** Abort reason: timeout (server-side) or client (client disconnected). */
export type StreamAbortReason = "timeout" | "client";

/**
 * Create AbortSignal that fires on client disconnect OR timeout.
 * Pass to provider stream so upstream is aborted when client leaves or timeout.
 * Optional onAbort reports reason for observability (llm_stream_aborted_timeout / llm_stream_aborted_client).
 */
export function createStreamAbortSignal(
  request: Request,
  timeoutMs: number = MAX_STREAM_DURATION_MS,
  onAbort?: (reason: StreamAbortReason) => void
): AbortSignal {
  const controller = new AbortController();
  let fired = false;
  const fire = (reason: StreamAbortReason) => {
    if (fired) return;
    fired = true;
    clearTimeout(timeoutId);
    onAbort?.(reason);
    controller.abort();
  };
  const timeoutId = setTimeout(() => fire("timeout"), timeoutMs);
  request.signal?.addEventListener?.(
    "abort",
    () => fire("client"),
    { once: true }
  );
  return controller.signal;
}

export function safeEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  data: string
): void {
  try {
    controller.enqueue(encoder.encode(data));
  } catch (e) {
    if (!isAlreadyClosed(e)) console.error("Stream enqueue failed:", e);
  }
}

/** Max polls when waiting for backpressure to clear. */
const BACKPRESSURE_MAX_POLLS = 200;

/**
 * Wait for backpressure to clear before enqueue. Prevents unbounded queue growth.
 * If controller.desiredSize <= 0, yields to next microtask up to BACKPRESSURE_MAX_POLLS.
 */
export async function waitForBackpressure(
  controller: ReadableStreamDefaultController<Uint8Array>
): Promise<void> {
  for (let i = 0; i < BACKPRESSURE_MAX_POLLS; i++) {
    const size = controller.desiredSize;
    if (size === null || size > 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Async enqueue with backpressure safety. Waits when desiredSize <= 0.
 */
export async function safeEnqueueWithBackpressure(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  data: string
): Promise<void> {
  await waitForBackpressure(controller);
  safeEnqueue(controller, encoder, data);
}

export function safeClose(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch (e) {
    if (!isAlreadyClosed(e)) console.error("Stream close failed:", e);
  }
}

function isAlreadyClosed(e: unknown): boolean {
  if (e instanceof TypeError) {
    const msg = (e as Error).message?.toLowerCase() ?? "";
    return msg.includes("already closed") || msg.includes("closed");
  }
  return false;
}
