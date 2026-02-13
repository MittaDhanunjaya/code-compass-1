/**
 * Streaming resilience: safe provider wrapping, typed error events, fallback.
 * Guarantees either streamed tokens OR a final structured error event.
 */

import { logger } from "@/lib/logger";
import { mergeAbortSignals } from "@/lib/stream-utils";
import type { ProviderId } from "@/lib/llm/providers";
import type { ChatMessage, ChatContext, StreamChunk } from "@/lib/llm/types";
import type { LLMProvider } from "@/lib/llm/types";

/** Typed error event emitted when streaming fails. */
export const AI_STREAM_FAILED = "AI_STREAM_FAILED" as const;

/** Emitted when all providers/models are exhausted (quota/rate-limit). */
export const ALL_MODELS_EXHAUSTED = "ALL_MODELS_EXHAUSTED" as const;

export type StreamErrorEvent = {
  type: "error";
  code: typeof AI_STREAM_FAILED | typeof ALL_MODELS_EXHAUSTED;
  provider: string;
  model: string;
  reason: string;
  message?: string;
  recommendedProviders?: string[];
  recommendedModels?: string[];
  userAction?: string;
};

/** Timeout for first token (ms). If no token in this window, fail/fallback. */
export const STREAM_FIRST_TOKEN_TIMEOUT_MS = 25_000;

/** Encode and enqueue a structured error event. Safe for closed controller. */
export function emitStreamErrorEvent(
  controller: ReadableStreamDefaultController<Uint8Array> | { enqueue: (chunk: Uint8Array) => void },
  encoder: TextEncoder,
  event: StreamErrorEvent
): void {
  try {
    const line = `\n${JSON.stringify(event)}`;
    controller.enqueue(encoder.encode(line));
  } catch (e) {
    if (process.env.NODE_ENV !== "test") {
      logger.warn({ event: "stream_error_emit_failed", ...event, emitError: String(e) });
    }
  }
}

export type EmitAllModelsExhaustedOptions = {
  provider: string;
  model: string;
  recommendedProviders: string[];
  recommendedModels: string[];
};

/** Emit ALL_MODELS_EXHAUSTED for UI model-switch prompt. */
export function emitAllModelsExhaustedEvent(
  controller: ReadableStreamDefaultController<Uint8Array> | { enqueue: (chunk: Uint8Array) => void },
  encoder: TextEncoder,
  opts: EmitAllModelsExhaustedOptions
): void {
  emitStreamErrorEvent(controller, encoder, {
    type: "error",
    code: ALL_MODELS_EXHAUSTED,
    provider: opts.provider,
    model: opts.model,
    reason: "All available AI models are currently rate-limited or out of quota.",
    message: "All available AI models are currently rate-limited or out of quota.",
    recommendedProviders: opts.recommendedProviders,
    recommendedModels: opts.recommendedModels,
    userAction: "switch_model_or_add_api_key",
  });
}

/** Check if a string is a stream error event (JSON with type:error and code). */
export function isStreamErrorEventLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { type?: string; code?: string };
    return parsed?.type === "error" && (parsed?.code === AI_STREAM_FAILED || parsed?.code === ALL_MODELS_EXHAUSTED);
  } catch {
    return false;
  }
}

/** Parse stream error event from line. */
export function parseStreamErrorEvent(line: string): StreamErrorEvent | null {
  try {
    const parsed = JSON.parse(line) as StreamErrorEvent;
    if (parsed?.type === "error" && (parsed?.code === AI_STREAM_FAILED || parsed?.code === ALL_MODELS_EXHAUSTED)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export type AllModelsExhaustedEvent = StreamErrorEvent & { code: typeof ALL_MODELS_EXHAUSTED };

export function isAllModelsExhaustedEvent(e: StreamErrorEvent | null): e is AllModelsExhaustedEvent {
  return e !== null && e.code === ALL_MODELS_EXHAUSTED;
}

export type SafeStreamCompletionOptions = {
  providerId: ProviderId;
  model: string | undefined;
  messages: ChatMessage[];
  apiKey: string;
  context?: ChatContext | null;
  signal?: AbortSignal | null;
  firstTokenTimeoutMs?: number;
  onFirstToken?: () => void;
};

export type SafeStreamResult =
  | { ok: true; content: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { ok: false; error: StreamErrorEvent };

/**
 * Run provider stream with timeout. On any error, returns StreamErrorEvent.
 * Does NOT retry or fallback; caller handles fallback.
 */
export async function* safeStreamCompletion(
  provider: LLMProvider,
  opts: SafeStreamCompletionOptions
): AsyncGenerator<StreamChunk, void, unknown> {
  const {
    providerId,
    model,
    messages,
    apiKey,
    context,
    signal,
    firstTokenTimeoutMs = STREAM_FIRST_TOKEN_TIMEOUT_MS,
    onFirstToken,
  } = opts;

  const startTime = Date.now();
  if (process.env.NODE_ENV !== "test") {
    logger.info({ event: "stream_start", provider: providerId, model: model ?? "default" });
  }

  let firstTokenReceived = false;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    if (!firstTokenReceived) {
      timeoutController.abort();
    }
  }, firstTokenTimeoutMs);

  const mergedSignal = mergeAbortSignals([timeoutController.signal, signal]);

  try {
    const stream = provider.stream(messages, apiKey, { context, model, signal: mergedSignal });
    for await (const chunk of stream as AsyncIterable<StreamChunk>) {
      clearTimeout(timeoutId);
      if (!firstTokenReceived) {
        firstTokenReceived = true;
        const firstTokenLatency = Date.now() - startTime;
        if (process.env.NODE_ENV !== "test") {
          logger.info({ event: "stream_first_token", provider: providerId, latencyMs: firstTokenLatency });
        }
        onFirstToken?.();
      }
      yield chunk;
    }
    if (process.env.NODE_ENV !== "test") {
      logger.info({
        event: "stream_close",
        provider: providerId,
        reason: "complete",
        durationMs: Date.now() - startTime,
      });
    }
  } catch (e) {
    clearTimeout(timeoutId);
    const reason = e instanceof Error ? e.message : String(e);
    if (process.env.NODE_ENV !== "test") {
      logger.warn({
        event: "stream_close",
        provider: providerId,
        model: model ?? "default",
        reason: "error",
        error: reason,
        durationMs: Date.now() - startTime,
      });
    }
    throw e;
  }
}

/**
 * Async iterate with timeout. Yields chunks. Throws on error.
 * Use with safeStreamCompletion for full observability.
 */
export async function* withStreamTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: () => void
): AsyncGenerator<T, void, unknown> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const resetTimeout = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      onTimeout?.();
      throw new Error(`Stream timeout after ${timeoutMs}ms`);
    }, timeoutMs);
  };
  resetTimeout();
  try {
    for await (const chunk of iterable) {
      resetTimeout();
      yield chunk;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
