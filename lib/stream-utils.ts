/**
 * Helpers for ReadableStream controllers so client abort doesn't throw
 * "Controller is already closed" or similar. Use before every enqueue/close.
 * Phase 6.2: Uses STREAMING_CONFIG from constants.
 */

import { STREAMING_CONFIG } from "@/lib/config/constants";
export const STREAM_UPSTREAM_TIMEOUT_MS = STREAMING_CONFIG.STREAM_UPSTREAM_TIMEOUT_MS;
export const MAX_STREAM_DURATION_MS = STREAMING_CONFIG.MAX_STREAM_DURATION_MS;

/** Check if we should stop streaming (client disconnected or timeout). */
export function shouldStopStream(request: Request, startTime: number, timeoutMs: number = STREAM_UPSTREAM_TIMEOUT_MS): boolean {
  if (request.signal?.aborted) return true;
  if (Date.now() - startTime > MAX_STREAM_DURATION_MS) return true;
  return Date.now() - startTime > timeoutMs;
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
