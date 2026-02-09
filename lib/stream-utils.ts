/**
 * Helpers for ReadableStream controllers so client abort doesn't throw
 * "Controller is already closed" or similar. Use before every enqueue/close.
 */

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
