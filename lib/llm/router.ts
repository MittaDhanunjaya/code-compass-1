/**
 * Central LLM access point. All model calls must go through this router.
 * Enforces: max tokens, timeouts, retries, model routing by task, token usage logging.
 * No direct OpenAI/OpenRouter calls outside this module.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LLMUsage } from "./types";
import type { ProviderId } from "./providers";
import { invokeChat as invokeChatInternal } from "./invoke";
import type { InvokeChatInput, InvokeChatOutput, InvokeChatCandidate } from "./invoke";
import { getModelForTask, type TaskType } from "./task-routing";
import { enforceAndRecordBudget, PER_REQUEST_MAX_TOKENS } from "@/lib/llm/budget-guard";

import { AGENT_CONFIG } from "@/lib/config/constants";
import { logger } from "@/lib/logger";
import { classifyErrorClass, AI_TEMPORARILY_UNAVAILABLE, ALL_MODELS_EXHAUSTED } from "@/lib/errors";
import { isAiEnabled } from "@/lib/ai-providers";
import { recordLLMLatency } from "@/lib/metrics";
import { getOrSetWithMeta } from "@/lib/cache";

/** Default timeout for non-streaming calls (ms). Phase 6.2: Uses AGENT_CONFIG. */
const DEFAULT_TIMEOUT_MS = AGENT_CONFIG.TIMEOUT_MS;

export type RouterInvokeInput = Omit<InvokeChatInput, "apiKey" | "providerId" | "model"> & {
  /** Override task-based routing when set. */
  providerId?: ProviderId;
  model?: string | null;
  apiKey: string;
  /** Max output tokens. */
  maxTokens?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** For structured logging. */
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  /** Phase 4.2.1: When provided with userId, enforces daily token budget. */
  supabase?: SupabaseClient;
  /** Phase 6.1.2: Optional cache key. When set, LLM response is cached (TTL 1h). */
  cacheKey?: string;
};

export type RouterInvokeOutput = InvokeChatOutput & {
  requestId?: string;
};

/**
 * Log token usage in a structured format for observability. Phase 12.1–12.2.
 */
function logTokenUsage(
  opts: {
    task: TaskType;
    providerId: ProviderId;
    model: string | undefined;
    usage?: LLMUsage | null;
    requestId?: string;
    userId?: string;
    workspaceId?: string;
    latencyMs: number;
  }
): void {
  if (process.env.NODE_ENV === "test") return;
  recordLLMLatency(opts.latencyMs);
  logger.info({
    event: "llm_token_usage",
    task: opts.task,
    providerId: opts.providerId,
    model: opts.model ?? "default",
    inputTokens: opts.usage?.inputTokens,
    outputTokens: opts.usage?.outputTokens,
    totalTokens: opts.usage?.totalTokens,
    latencyMs: opts.latencyMs,
    requestId: opts.requestId,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
  });
}

/**
 * Invoke chat through the router. Enforces max tokens, timeout, and logs usage.
 * Use this instead of direct provider.chat() or lib/llm/invoke.
 */
export async function invokeChat(input: RouterInvokeInput): Promise<RouterInvokeOutput> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    requestId,
    userId,
    workspaceId,
    supabase,
    task = "chat",
    ...rest
  } = input;

  if (!isAiEnabled()) {
    const err = new Error("AI providers disabled") as Error & { code?: string };
    err.code = AI_TEMPORARILY_UNAVAILABLE;
    throw err;
  }
  if (process.env.NODE_ENV === "production" && !userId) {
    throw new Error("LLM calls require user context in production.");
  }
  if (supabase && userId) {
    const maxTokens = input.maxTokens ?? 8192;
    const tokensToReserve = Math.min(maxTokens * 2, PER_REQUEST_MAX_TOKENS * 2);
    await enforceAndRecordBudget(supabase, userId, tokensToReserve, workspaceId);
  }

  // Resolve provider/model: use explicit override or task-based routing
  let providerId: ProviderId;
  let model: string | undefined;
  if (input.providerId) {
    providerId = input.providerId;
    const { getModelForProvider } = await import("./providers");
    model = getModelForProvider(providerId, input.model) ?? undefined;
  } else {
    const resolved = getModelForTask(task);
    providerId = resolved.providerId;
    model = resolved.model;
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  const defaultMaxTokens = 8192; // Phase 4.2.2: Per-request cap
  const maxTokens = input.maxTokens ?? defaultMaxTokens;

  const doInvoke = () =>
    Promise.race([
      invokeChatInternal({
        ...rest,
        apiKey: input.apiKey,
        providerId,
        model,
        task,
        maxTokens,
        context: rest.context ?? (workspaceId ? { workspaceId } : undefined),
      }),
      timeoutPromise,
    ]);

  try {
    let result: Awaited<ReturnType<typeof doInvoke>>;
    let fromCache = false;
    if (input.cacheKey) {
      const { value, cached } = await getOrSetWithMeta(
        `llm:${input.cacheKey}`,
        3600000, // 1h TTL
        doInvoke,
        { serialize: (v) => JSON.stringify(v), deserialize: (s) => JSON.parse(s) as Awaited<ReturnType<typeof doInvoke>> }
      );
      result = value;
      fromCache = cached;
    } else {
      result = await doInvoke();
    }

    // Log token usage (skip increment when cached)
    if (!fromCache) {
        logTokenUsage({
        task,
        providerId: result.providerId,
        model: result.model,
        usage: result.usage,
        requestId,
        userId,
        workspaceId,
        latencyMs: result.latencyMs,
      });

      // Budget already reserved via enforceAndRecordBudget before the call.
    }

    return { ...result, requestId };
  } catch (e) {
    if (process.env.NODE_ENV !== "test") {
      logger.error({
        event: "llm_router_error",
        task,
        providerId,
        model,
        requestId,
        userId,
        workspaceId,
        errorClass: classifyErrorClass(e),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw e;
  }
}

export type RouterInvokeWithFallbackInput = Omit<RouterInvokeInput, "providerId" | "model" | "apiKey"> & {
  candidates: InvokeChatCandidate[];
};

/**
 * Invoke chat with fallback over multiple candidates. Uses router for each attempt.
 * Skips provider+model when isQuotaExceededError (no retry in same request).
 */
export async function invokeChatWithFallback(
  input: RouterInvokeWithFallbackInput
): Promise<RouterInvokeOutput> {
  const { candidates, requestId, userId, workspaceId, task = "chat", ...rest } = input;
  if (candidates.length === 0) throw new Error("At least one candidate required");

  const { isFallbackableError, isQuotaExceededError } = await import("./rate-limit");
  const { createProviderAvailabilityTracker, markUnavailable, isMarkedUnavailable } = await import("./provider-availability");

  const tracker = createProviderAvailabilityTracker();
  const getModel = (c: (typeof candidates)[0]) => c.model ?? "default";

  const throwAllFailed = (code: string) => {
    const err = new Error("All AI providers failed") as Error & { code?: string; recommendedProviders?: string[]; recommendedModels?: string[] };
    err.code = code;
    err.recommendedProviders = [...new Set(candidates.map((x) => x.providerId))];
    err.recommendedModels = [...new Set(candidates.map((x) => x.model ?? "default"))];
    throw err;
  };

  let idx = 0;
  while (idx < candidates.length) {
    const c = candidates[idx];
    if (isMarkedUnavailable(tracker, c.providerId, getModel(c))) {
      idx++;
      continue;
    }
    try {
      return await invokeChat({
        ...rest,
        apiKey: c.apiKey,
        providerId: c.providerId,
        model: c.model,
        task,
        requestId,
        userId,
        workspaceId,
      });
    } catch (e) {
      if (isQuotaExceededError(e)) {
        markUnavailable(tracker, c.providerId, getModel(c), "quota_exceeded");
      }
      if (!isFallbackableError(e)) throw e;
      const nextIdx = candidates.findIndex((x, i) => i > idx && !isMarkedUnavailable(tracker, x.providerId, getModel(x)));
      const next = nextIdx >= 0 ? candidates[nextIdx] : undefined;
      if (!next) {
        throwAllFailed(isQuotaExceededError(e) ? ALL_MODELS_EXHAUSTED : AI_TEMPORARILY_UNAVAILABLE);
      }
      if (process.env.NODE_ENV !== "test" && next) {
        logger.warn({
          event: "llm_router_fallback",
          provider: c.providerId,
          model: c.model ?? "default",
          reason: e instanceof Error ? e.message : String(e),
          retryingWith: next.providerId,
        });
      }
      idx = nextIdx;
    }
  }
  throwAllFailed(ALL_MODELS_EXHAUSTED);
}

// Re-export for consumers that need the raw invoke (e.g. streaming with custom handling)
export { invokeChat as _rawInvokeChat } from "./invoke";
export type { InvokeChatInput, InvokeChatOutput, InvokeChatCandidate } from "./invoke";
