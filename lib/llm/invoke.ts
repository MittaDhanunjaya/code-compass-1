/**
 * Provider abstraction: standardized invokeChat and invokeToolUse with
 * central retries, rate-limit handling, and logging.
 */

import type { ChatMessage, ChatContext, LLMUsage } from "./types";
import { getProvider, getModelForProvider, type ProviderId } from "./providers";
import { isRateLimitError, isFallbackableError, isTimeoutError } from "./rate-limit";
import { withRetry } from "./retry-handler";

export type TaskType = "planning" | "qa" | "patch" | "review" | "chat" | "inline_edit" | "debug";

export type InvokeChatInput = {
  messages: ChatMessage[];
  apiKey: string;
  providerId: ProviderId;
  model?: string | null;
  context?: ChatContext | null;
  /** For logging and task-based routing. */
  task?: TaskType;
  /** Optional temperature (e.g. 0.3 for debug to reduce same-output repetition). */
  temperature?: number;
  /** Phase 4.2.2: Per-request token cap (max output tokens). */
  maxTokens?: number;
};

export type InvokeChatOutput = {
  content: string;
  usage?: LLMUsage;
  providerId: ProviderId;
  model: string | undefined;
  latencyMs: number;
  retries: number;
};

/** Tool call (for future use). Standardized shape. */
export type ToolCallSpec = {
  id: string;
  name: string;
  arguments: string;
};

export type InvokeToolUseInput = InvokeChatInput & {
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
};

export type InvokeToolUseOutput = InvokeChatOutput & {
  toolCalls?: ToolCallSpec[];
};

/** Retry on rate limit or timeout (network issues). */
function isRetryableLlmError(e: unknown): boolean {
  return isRateLimitError(e) || isTimeoutError(e);
}

/**
 * Invoke chat with retries (on rate limit/timeout), logging, and standardized output.
 * Phase 6.3: Uses withRetry from retry-handler.
 */
export async function invokeChat(input: InvokeChatInput): Promise<InvokeChatOutput> {
  const { messages, apiKey, providerId, model, context, task = "chat", temperature, maxTokens } = input;
  const provider = getProvider(providerId);
  const modelOpt = getModelForProvider(providerId, model ?? undefined);
  const start = Date.now();
  let retries = 0;

  const result = await withRetry(
    async () => {
      const { content, usage } = await provider.chat(messages, apiKey, {
        model: modelOpt,
        context,
        temperature,
        maxTokens,
      });
      return { content, usage };
    },
    {
      isRetryable: isRetryableLlmError,
    }
  ).catch((e) => {
    retries = 1; // Simplified; withRetry doesn't expose attempt count
    const latencyMs = Date.now() - start;
    if (process.env.NODE_ENV !== "test") {
      console.error(
        JSON.stringify({
          event: "llm_invoke_error",
          task,
          providerId,
          latencyMs,
          retries,
          error: e instanceof Error ? e.message : String(e),
        })
      );
    }
    throw e;
  });

  const latencyMs = Date.now() - start;
  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        event: "llm_invoke",
        task,
        providerId,
        model: modelOpt ?? "default",
        latencyMs,
        retries,
        ok: true,
      })
    );
  }
  return {
    ...result,
    providerId,
    model: modelOpt,
    latencyMs,
    retries,
  };
}

/**
 * Invoke with optional tool use. Providers that support tools can use them;
 * others fall back to chat. Currently all providers use chat only.
 */
export async function invokeToolUse(input: InvokeToolUseInput): Promise<InvokeToolUseOutput> {
  const base: InvokeChatInput = {
    messages: input.messages,
    apiKey: input.apiKey,
    providerId: input.providerId,
    model: input.model,
    context: input.context,
    task: input.task,
  };
  const result = await invokeChat(base);
  return {
    ...result,
    toolCalls: undefined,
  };
}

/** One candidate for fallback: provider, model slug, and API key (empty for local). */
export type InvokeChatCandidate = {
  providerId: ProviderId;
  model?: string | null;
  apiKey: string;
};

/**
 * Try invokeChat with each candidate in order; return first success.
 * On rate limit / 404 / timeout, try next candidate. Throw last error if all fail.
 */
export async function invokeChatWithFallback(
  input: Omit<InvokeChatInput, "apiKey" | "providerId" | "model">,
  candidates: InvokeChatCandidate[]
): Promise<InvokeChatOutput> {
  let lastError: unknown;
  for (const c of candidates) {
    try {
      return await invokeChat({
        ...input,
        apiKey: c.apiKey,
        providerId: c.providerId,
        model: c.model,
      });
    } catch (e) {
      lastError = e;
      const nextIdx = candidates.indexOf(c) + 1;
      const next = candidates[nextIdx];
      if (!isFallbackableError(e) || !next) throw e;
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          JSON.stringify({
            event: "llm_invoke_fallback",
            provider: c.providerId,
            model: c.model ?? "default",
            reason: e instanceof Error ? e.message : String(e),
            retryingWith: next.providerId,
          })
        );
      }
    }
  }
  throw lastError;
}
