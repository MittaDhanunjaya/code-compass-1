/**
 * Frontend stream consumer hardening.
 * Handles empty stream, premature close, error event frames.
 * Display visible UI error instead of infinite loading.
 */

import { AI_STREAM_FAILED, ALL_MODELS_EXHAUSTED, parseStreamErrorEvent } from "@/lib/stream-resilience";

export type StreamErrorEvent = {
  type: "error";
  code: string;
  provider: string;
  model: string;
  reason: string;
  recommendedProviders?: string[];
  recommendedModels?: string[];
};

/** User-facing message for AI stream/availability errors. */
export const AI_STREAM_FAILED_MESSAGE = "AI temporarily unavailable. Please try again in a moment.";

/** Result type for stream consumption. Includes structured ALL_MODELS_EXHAUSTED for UI. */
export type StreamConsumeResult =
  | { content: string; error: null; code?: never; recommendedProviders?: never; recommendedModels?: never }
  | { content: string; error: string; code?: string; recommendedProviders?: string[]; recommendedModels?: string[] };

/**
 * Consume a text stream, accumulating content and detecting error events.
 * Returns { content, error } - exactly one will be set when stream ends.
 * On ALL_MODELS_EXHAUSTED, also returns code, recommendedProviders, recommendedModels for UI.
 */
export async function consumeStreamWithErrorHandling(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<StreamConsumeResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let streamError: StreamErrorEvent | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parseStreamErrorEvent(trimmed);
        if (parsed) {
          streamError = parsed;
          content = content.replace(new RegExp(`\n?${escapeRegExp(trimmed)}$`), "");
          continue;
        }
        content += line + "\n";
      }

      if (done) {
        if (buffer.trim()) {
          const parsed = parseStreamErrorEvent(buffer.trim());
          if (parsed) {
            streamError = parsed;
          } else {
            content += buffer;
          }
        }
        break;
      }
    }
  } catch (e) {
    return {
      content: "",
      error: e instanceof Error ? e.message : "Stream read failed",
    };
  }

  if (streamError) {
    const err: StreamConsumeResult = {
      content: "",
      error: streamError.reason || AI_STREAM_FAILED_MESSAGE,
    };
    if (streamError.code === ALL_MODELS_EXHAUSTED) {
      err.code = ALL_MODELS_EXHAUSTED;
      err.recommendedProviders = streamError.recommendedProviders ?? [];
      err.recommendedModels = streamError.recommendedModels ?? [];
    }
    return err;
  }

  return { content: content.trimEnd(), error: null };
}

/**
 * Consume SSE-style stream (data: {...}\n). Accumulates content, detects error events.
 * For agent plan/execute streams. Returns { content, error, parsedEvents }.
 */
export async function consumeSSEStreamWithErrorHandling(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: {
    onEvent?: (data: unknown) => void;
    extractError?: (data: unknown) => string | null;
  }
): Promise<{ content: string; error: string | null }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let streamError: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const data = JSON.parse(jsonStr) as Record<string, unknown>;
          options?.onEvent?.(data);

          if (data?.type === "error" && data?.code === AI_STREAM_FAILED) {
            streamError = (data.reason as string) || AI_STREAM_FAILED_MESSAGE;
            continue;
          }
          if (options?.extractError) {
            const err = options.extractError(data);
            if (err) streamError = err;
          }
          content += line + "\n";
        } catch {
          content += line + "\n";
        }
      }

      if (done) {
        if (buffer.trim() && buffer.startsWith("data: ")) {
          try {
            const data = JSON.parse(buffer.slice(6).trim()) as Record<string, unknown>;
            if (data?.type === "error" && data?.code === AI_STREAM_FAILED) {
              streamError = (data.reason as string) || AI_STREAM_FAILED_MESSAGE;
            }
          } catch {
            content += buffer;
          }
        }
        break;
      }
    }
  } catch (e) {
    return {
      content: "",
      error: e instanceof Error ? e.message : "Stream read failed",
    };
  }

  if (streamError) {
    return { content: "", error: streamError };
  }
  return { content, error: null };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
