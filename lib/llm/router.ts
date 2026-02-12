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
import {
  checkTokenBudget,
  checkWorkspaceTokenBudget,
  incrementTokenUsage,
  incrementWorkspaceTokenUsage,
} from "@/lib/token-budget";

import { AGENT_CONFIG } from "@/lib/config/constants";
import { logger } from "@/lib/logger";
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

  // Phase 4.2.1 & 4.2.4: Check token budget before LLM call
  if (supabase && userId) {
    const budget = await checkTokenBudget(supabase, userId);
    if (!budget.ok) {
      const err = new Error("Daily token budget exceeded. Try again tomorrow.") as Error & {
        statusCode?: number;
        retryAfter?: number;
      };
      err.statusCode = 429;
      err.retryAfter = budget.retryAfter;
      throw err;
    }
  }
  // Phase 4.2.3: Check per-workspace budget when workspaceId provided
  if (supabase && workspaceId) {
    const wsBudget = await checkWorkspaceTokenBudget(supabase, workspaceId);
    if (!wsBudget.ok) {
      const err = new Error("Workspace daily token limit exceeded. Try again tomorrow.") as Error & {
        statusCode?: number;
        retryAfter?: number;
      };
      err.statusCode = 429;
      err.retryAfter = wsBudget.retryAfter;
      throw err;
    }
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

      // Phase 4.2.1 & 4.2.3: Increment token usage (user + workspace)
      if (supabase && result.usage?.totalTokens) {
        if (userId) await incrementTokenUsage(supabase, userId, result.usage.totalTokens);
        if (workspaceId) await incrementWorkspaceTokenUsage(supabase, workspaceId, result.usage.totalTokens);
      }
    }

    return { ...result, requestId };
  } catch (e) {
    if (process.env.NODE_ENV !== "test") {
      logger.error({
        event: "llm_router_error",
        task,
        providerId,
        requestId,
        userId,
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
 */
export async function invokeChatWithFallback(
  input: RouterInvokeWithFallbackInput
): Promise<RouterInvokeOutput> {
  const { candidates, requestId, userId, workspaceId, task = "chat", ...rest } = input;
  const last = candidates[candidates.length - 1];
  if (!last) throw new Error("At least one candidate required");

  let lastError: unknown;
  for (const c of candidates) {
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
      lastError = e;
      const { isFallbackableError } = await import("./rate-limit");
      if (!isFallbackableError(e) || c === last) throw e;
      if (process.env.NODE_ENV !== "test") {
        logger.warn({
          event: "llm_router_fallback",
          task,
          from: c.providerId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  throw lastError;
}

// Re-export for consumers that need the raw invoke (e.g. streaming with custom handling)
export { invokeChat as _rawInvokeChat } from "./invoke";
export type { InvokeChatInput, InvokeChatOutput, InvokeChatCandidate } from "./invoke";
