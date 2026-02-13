/**
 * Phase 2.1.3: Chat service.
 * Extracts business logic from chat routes. Routes are thin: parse input → call service → return.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { invokeChatWithFallback, type InvokeChatCandidate } from "@/lib/llm/router";
import type { ChatMessage, ChatContext } from "@/lib/llm/types";
import { getTextFromContent } from "@/lib/llm/types";
import type { SearchResult } from "@/lib/indexing/types";
import { detectErrorLogKind } from "@/lib/agent/error-log-utils";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { loadChatHistory, saveChatMessage } from "@/lib/chat-memory";
import { logger } from "@/lib/logger";
import {
  safeEnqueue,
  safeEnqueueWithBackpressure,
  safeClose,
  shouldStopStream,
  createStreamAbortSignal,
  mergeAbortSignals,
  MAX_STREAM_DURATION_MS,
  STREAM_FIRST_TOKEN_TIMEOUT_MS,
} from "@/lib/stream-utils";
import {
  emitStreamErrorEvent,
  emitAllModelsExhaustedEvent,
  AI_STREAM_FAILED,
} from "@/lib/stream-resilience";
import { orderProviderKeysByPreference } from "@/lib/ai-providers";
import {
  createProviderAvailabilityTracker,
  markUnavailable,
  getAvailablePairs,
} from "@/lib/llm/provider-availability";
import { isQuotaExceededError } from "@/lib/llm/rate-limit";
import { refundBudget, estimateTokensFromChars } from "@/lib/llm/budget-guard";
import { reconcileBudgetWithUsage } from "@/lib/llm/budget-reconciliation";
import { recordLLMBudgetRefunded, recordLLMStreamAbortedTimeout, recordLLMStreamAbortedClient } from "@/lib/metrics";
import type { StreamChunk } from "@/lib/llm/types";

export type ChatCompletionInput = {
  messages: ChatMessage[];
  context?: ChatContext | null;
  model?: string;
  provider?: ProviderId;
  runType?: "chat" | "debug" | "agent" | "refactor";
  workspaceId?: string | null;
  userId: string;
  supabase: SupabaseClient;
  origin?: string;
};

export type ChatCompletionResult = {
  content: string;
  provider: ProviderId;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  kind: "normal" | "error_log" | "unknown";
  contextUsed?: { filePaths: string[]; rulesIncluded: boolean };
  noWorkspaceErrorLog?: boolean;
};

/**
 * Resolve API key for a provider. Tries requested provider first, then fallbacks.
 */
export async function getChatProviderKeys(
  supabase: SupabaseClient,
  userId: string,
  requestedProvider?: ProviderId
): Promise<{ providerId: ProviderId; apiKey: string }[] | null> {
  const providersToTry = requestedProvider
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  const result: { providerId: ProviderId; apiKey: string }[] = [];
  for (const p of providersToTry) {
    const { data: keyRow, error } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", userId)
      .eq("provider", p)
      .maybeSingle();

    if (error || !keyRow?.key_encrypted) continue;
    try {
      const apiKey = decrypt(keyRow.key_encrypted);
      result.push({ providerId: p, apiKey });
    } catch {
      continue;
    }
  }
  return result.length > 0 ? result : null;
}

/**
 * Get single provider key (for non-streaming chat). Returns first available.
 */
export async function getChatApiKey(
  supabase: SupabaseClient,
  userId: string,
  requestedProvider?: ProviderId
): Promise<{ apiKey: string; providerId: ProviderId } | { error: string; decryptFailed?: boolean }> {
  const providersToTry = requestedProvider
    ? [requestedProvider, ...PROVIDERS.filter((p) => p !== requestedProvider)]
    : [...PROVIDERS];

  let decryptFailed = false;
  for (const p of providersToTry) {
    const { data: keyRow, error } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", userId)
      .eq("provider", p)
      .maybeSingle();

    if (error) continue;
    if (keyRow?.key_encrypted) {
      try {
        const apiKey = decrypt(keyRow.key_encrypted);
        return { apiKey, providerId: p };
      } catch {
        decryptFailed = true;
        continue;
      }
    }
  }

  if (decryptFailed) {
    return { error: "Stored API key could not be decrypted. Please re-enter your API key in Settings → API Keys.", decryptFailed: true };
  }
  const label = requestedProvider ? PROVIDER_LABELS[requestedProvider] : "Selected provider";
  return { error: `No API key configured for ${label}. Add one in API Key settings.` };
}

/**
 * Non-streaming chat completion. Merges history, adds context, invokes LLM, saves.
 */
export async function chatCompletion(input: ChatCompletionInput): Promise<ChatCompletionResult> {
  const { messages: rawMessages, context, model, provider, runType, workspaceId, userId, supabase, origin } = input;
  let messages = [...rawMessages];
  const lastMessage = messages[messages.length - 1];

  if (workspaceId) {
    const history = await loadChatHistory(supabase, workspaceId, userId, 30);
    if (history.length > 0) {
      const historyMap = new Map<string, boolean>();
      history.forEach((m) => {
        const text = getTextFromContent(m.content);
        historyMap.set(`${m.role}:${text.slice(0, 50)}`, true);
      });
      const newHistory = history.filter((h) => {
        const hText = getTextFromContent(h.content);
        return !historyMap.has(`${h.role}:${hText.slice(0, 50)}`) || !messages.some((m) => m.role === h.role && getTextFromContent(m.content) === hText);
      });
      messages = [...newHistory, ...messages];
    }
  }

  const providerKeys = await getChatProviderKeys(supabase, userId, provider);
  if (!providerKeys || providerKeys.length === 0) {
    const keyResult = await getChatApiKey(supabase, userId, provider);
    if ("error" in keyResult) {
      throw new ChatServiceError(keyResult.error, keyResult.decryptFailed ? "decrypt_failed" : "no_key");
    }
    throw new ChatServiceError("No API key configured. Add one in Settings → API Keys.", "no_key");
  }
  const orderedKeys = orderProviderKeysByPreference(providerKeys);

  let searchResults: SearchResult[] = [];
  const lastText = getTextFromContent(lastMessage?.content ?? "");
  const codebaseMatch = lastText.match(/@codebase\s+"([^"]+)"/i) ?? lastText.match(/@codebase\s+(\S+)/i);

  if (codebaseMatch && workspaceId) {
    const searchQuery = codebaseMatch[1];
    try {
      const base = origin || "http://localhost:3000";
      const searchRes = await fetch(
        `${base}/api/search?query=${encodeURIComponent(searchQuery)}&workspaceId=${workspaceId}&limit=10&semantic=true`
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json().catch(() => ({}));
        searchResults = Array.isArray((searchData as { results?: SearchResult[] })?.results)
          ? (searchData as { results: SearchResult[] }).results
          : [];
      } else {
        const { data: chunks } = await supabase
          .from("code_chunks")
          .select("file_path, content, symbols, chunk_index")
          .eq("workspace_id", workspaceId)
          .ilike("content", `%${searchQuery}%`)
          .limit(10);
        if (chunks?.length) {
          const queryLower = searchQuery.toLowerCase();
          const resultsMap = new Map<string, SearchResult>();
          for (const chunk of chunks) {
            const path = chunk.file_path;
            const content = chunk.content ?? "";
            const lines = content.split("\n");
            let matchLine: number | undefined;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(queryLower)) {
                matchLine = i + 1;
                break;
              }
            }
            const previewStart = Math.max(0, (matchLine ?? 1) - 2);
            const previewEnd = Math.min(lines.length, previewStart + 5);
            const preview = lines.slice(previewStart, previewEnd).join("\n");
            if (!resultsMap.has(path)) {
              resultsMap.set(path, { path, line: matchLine, preview: preview.slice(0, 500) });
            }
          }
          searchResults = Array.from(resultsMap.values()).slice(0, 5);
        }
      }
    } catch {
      // Search failed, continue without
    }
  }

  let rulesPrompt = "";
  if (workspaceId) {
    try {
      const rules = await loadRules(supabase, workspaceId);
      rulesPrompt = formatRulesForPrompt(rules);
    } catch {
      rulesPrompt = "";
    }
  }

  const enhancedMessages: ChatMessage[] = [...messages];
  if (searchResults.length > 0) {
    const codebaseContext = `Relevant codebase context from search:\n\n${searchResults
      .map((r) => `File: ${r.path}${r.line ? ` (line ${r.line})` : ""}\n\`\`\`\n${r.preview}\n\`\`\``)
      .join("\n\n")}${rulesPrompt}`;
    enhancedMessages.splice(enhancedMessages.length - 1, 0, { role: "system", content: codebaseContext });
  } else if (rulesPrompt) {
    enhancedMessages.splice(enhancedMessages.length - 1, 0, { role: "system", content: rulesPrompt.trim() });
  }

  function defaultModelForProvider(p: ProviderId): string {
    const m = getModelForProvider(p, model);
    if (m != null && m !== "") return m;
    if (p === "openrouter") return "openrouter/free";
    if (p === "gemini") return "gemini-2.0-flash";
    if (p === "openai") return "gpt-4o-mini";
    if (p === "perplexity") return "sonar";
    if (p === "ollama") return "llama3.2";
    return "default";
  }

  const candidates: InvokeChatCandidate[] = orderedKeys.map(({ providerId, apiKey }) => ({
    providerId,
    apiKey,
    model: defaultModelForProvider(providerId),
  }));

  const { content, usage, providerId } = await invokeChatWithFallback({
    messages: enhancedMessages,
    context,
    task: "chat",
    userId,
    workspaceId: context?.workspaceId ?? undefined,
    supabase,
    candidates,
  });

  if (workspaceId) {
    const lastUserContent = getTextFromContent(lastMessage?.content ?? "");
    const rt = runType ?? "chat";
    try {
      await saveChatMessage(supabase, workspaceId, userId, "user", lastUserContent, { runType: rt });
      await saveChatMessage(supabase, workspaceId, userId, "assistant", content, { runType: rt });
    } catch (e) {
      logger.warn({ event: "save_chat_history_failed", workspaceId, userId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const kind = detectErrorLogKind(getTextFromContent(lastMessage?.content ?? ""));
  const noWorkspaceErrorLog = kind === "error_log" && !workspaceId;
  const contextUsed =
    searchResults.length > 0 || rulesPrompt.length > 0
      ? { filePaths: searchResults.map((r) => r.path), rulesIncluded: rulesPrompt.length > 0 }
      : undefined;

  return {
    content,
    provider: providerId,
    usage,
    kind,
    contextUsed,
    ...(noWorkspaceErrorLog ? { noWorkspaceErrorLog: true } : {}),
  };
}

export class ChatServiceError extends Error {
  constructor(
    message: string,
    public readonly code: "no_key" | "decrypt_failed"
  ) {
    super(message);
    this.name = "ChatServiceError";
  }
}

function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    /\b429\b|"code":\s*429|"status":\s*429/.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("too many requests")
  );
}

function isInvalidModelError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    /\b400\b/.test(msg) &&
    (lower.includes("not a valid model") ||
      lower.includes("invalid model") ||
      lower.includes("model_id") ||
      lower.includes("model id"))
  );
}

export function getUserFacingChatError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (isRateLimitError(e)) {
    return "This provider's rate limit was reached. Try again in a minute or use another provider (API Keys).";
  }
  try {
    const parsed = JSON.parse(msg) as { error?: { message?: string } };
    const inner = parsed?.error?.message;
    if (typeof inner === "string" && inner.length < 300) return inner;
    if (typeof inner === "string") return inner.slice(0, 200) + "…";
  } catch {
    // ignore
  }
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

export type ChatStreamInput = {
  messages: ChatMessage[];
  context?: ChatContext | null;
  model?: string;
  providerKeys: { providerId: ProviderId; apiKey: string }[];
  request: Request;
  /** Request correlation for logs (stream_start, stream_first_token, stream_close, fallback). */
  requestId?: string;
  /** When provided, refund unused tokens on completion/abort. */
  budget?: {
    userId: string;
    workspaceId?: string | null;
    tokensReserved: number;
    supabase: SupabaseClient;
    /** When provider returns usage, reconcile reserved vs actual. Optional. */
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    /** Phase 4: Called when stream ends (for releasing stream slot). */
    onComplete?: () => void | Promise<void>;
  };
};

function emitFinalError(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  providerId: string,
  modelOpt: string | undefined,
  reason: string
): void {
  emitStreamErrorEvent(controller, encoder, {
    type: "error",
    code: AI_STREAM_FAILED,
    provider: providerId,
    model: modelOpt ?? "default",
    reason,
  });
}

/**
 * Create a streaming chat response. Tries providers in order.
 * On stream failure (before first token): fallback to non-streaming.
 * Single-writer: once first token yields, stream is locked; no fallback writes.
 * Guarantees exactly one terminal event: content completion OR structured error.
 */
export function createChatStream(input: ChatStreamInput): ReadableStream<Uint8Array> {
  const { messages, context, model, providerKeys, request, requestId, budget } = input;

  const orderedKeys = orderProviderKeysByPreference(providerKeys);
  const availabilityTracker = createProviderAvailabilityTracker();

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const startTime = Date.now();
      let abortReason: "timeout" | "client" | null = null;
      const clientSignal = createStreamAbortSignal(request, MAX_STREAM_DURATION_MS, (reason) => {
        abortReason = reason;
      });

      const firstTokenTimeoutController = new AbortController();
      const firstTokenTimeoutId = setTimeout(() => firstTokenTimeoutController.abort(), STREAM_FIRST_TOKEN_TIMEOUT_MS);
      const mergedSignal = mergeAbortSignals([clientSignal, firstTokenTimeoutController.signal]);

      let totalChars = 0;
      let providerUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null;
      let streamSucceeded = false;
      let streamLocked = false;
      let emittedTerminalError = false;
      let allFailedDueToQuota = true;

      const meta = { requestId };
      if (process.env.NODE_ENV !== "test") {
        logger.info({ event: "stream_start", provider: "pending", ...meta });
      }

      const enqueue = async (data: string) => {
        await safeEnqueueWithBackpressure(controller, encoder, data);
      };

      const getModelForPair = (p: { providerId: ProviderId; apiKey: string }) =>
        getModelForProvider(p.providerId, model) ?? "default";

      try {
        let lastError: unknown = null;
        let lastProviderId: ProviderId = orderedKeys[0]?.providerId ?? "unknown";

        for (const { providerId, apiKey } of getAvailablePairs(availabilityTracker, orderedKeys, getModelForPair)) {
          if (mergedSignal.aborted) break;
          if (shouldStopStream(request, startTime, MAX_STREAM_DURATION_MS)) break;

          const p = getProvider(providerId);
          const modelOpt = getModelForProvider(providerId, model);
          lastProviderId = providerId;

          const providerAbortController = new AbortController();
          const providerSignal = mergeAbortSignals([mergedSignal, providerAbortController.signal]);

          try {
            let firstToken = false;
            for await (const chunk of p.stream(messages, apiKey, { context, model: modelOpt, signal: providerSignal }) as AsyncIterable<StreamChunk>) {
              clearTimeout(firstTokenTimeoutId);
              if (!firstToken) {
                firstToken = true;
                streamLocked = true;
                if (process.env.NODE_ENV !== "test") {
                  logger.info({ event: "stream_first_token", provider: providerId, latencyMs: Date.now() - startTime, ...meta });
                }
              }
              if (providerSignal.aborted || shouldStopStream(request, startTime, MAX_STREAM_DURATION_MS)) break;
              if (typeof chunk === "string") {
                totalChars += chunk.length;
                await enqueue(chunk);
              } else if (chunk && typeof chunk === "object" && "type" in chunk && chunk.type === "usage" && chunk.usage) {
                providerUsage = chunk.usage;
              }
            }

            if (totalChars === 0) {
              lastError = new Error("Provider returned no content. Try a different provider or retry.");
              if (!isRateLimitError(lastError) && !isInvalidModelError(lastError)) {
                allFailedDueToQuota = false;
                emitFinalError(controller, encoder, providerId, modelOpt, "Provider returned no content. Try a different provider or retry.");
                emittedTerminalError = true;
                break;
              }
            } else {
              streamSucceeded = true;
              lastError = null;
              allFailedDueToQuota = false;
              break;
            }
          } catch (streamErr) {
            clearTimeout(firstTokenTimeoutId);
            if (streamLocked) {
              lastError = streamErr;
              allFailedDueToQuota = false;
              emitFinalError(controller, encoder, providerId, modelOpt, getUserFacingChatError(streamErr));
              break;
            }

            if (mergedSignal.aborted) break;

            if (isQuotaExceededError(streamErr)) {
              markUnavailable(availabilityTracker, providerId, modelOpt ?? "default", "quota_exceeded");
            }

            providerAbortController.abort();

            const reason = streamErr instanceof Error ? streamErr.message : String(streamErr);
            if (process.env.NODE_ENV !== "test") {
              logger.warn({ event: "stream_fallback", provider: providerId, reason, action: "retrying_non_streaming", ...meta });
            }

            try {
              const { content, usage } = await p.chat(messages, apiKey, { context, model: modelOpt });
              providerUsage = usage ?? null;
              totalChars = content.length;
              await enqueue(content);
              streamSucceeded = true;
              lastError = null;
              allFailedDueToQuota = false;
              if (process.env.NODE_ENV !== "test") {
                logger.info({ event: "stream_fallback_used", provider: providerId, success: true, ...meta });
              }
              break;
            } catch (fallbackErr) {
              lastError = fallbackErr;
              if (isQuotaExceededError(fallbackErr)) {
                markUnavailable(availabilityTracker, providerId, modelOpt ?? "default", "quota_exceeded");
              } else {
                allFailedDueToQuota = false;
              }
              if (!isRateLimitError(fallbackErr) && !isInvalidModelError(fallbackErr)) {
                emitFinalError(controller, encoder, providerId, modelOpt, getUserFacingChatError(fallbackErr));
                break;
              }
            }
          }
        }

        if (!streamSucceeded && !emittedTerminalError) {
          const errProviderId = lastProviderId;
          const modelOpt = getModelForProvider(errProviderId, model);
          const recommendedProviders = [...new Set(orderedKeys.map((p) => p.providerId))];
          const recommendedModels = [...new Set(orderedKeys.map((p) => getModelForProvider(p.providerId, model) ?? "default"))];

          if (allFailedDueToQuota && recommendedProviders.length > 0) {
            emitAllModelsExhaustedEvent(controller, encoder, {
              provider: errProviderId,
              model: modelOpt ?? "default",
              recommendedProviders,
              recommendedModels,
            });
          } else {
            const reason = lastError != null
              ? ((isRateLimitError(lastError) || isInvalidModelError(lastError))
                ? getUserFacingChatError(lastError) + " Try selecting a different provider (e.g. OpenAI) in the dropdown above if you have an API key."
                : getUserFacingChatError(lastError))
              : "Stream closed prematurely (client disconnect or timeout).";
            emitFinalError(controller, encoder, errProviderId, modelOpt, reason);
          }
        }

        if (process.env.NODE_ENV !== "test") {
          logger.info({ event: "stream_close", reason: streamSucceeded ? "complete" : "error", durationMs: Date.now() - startTime, ...meta });
        }
      } catch (e) {
        emitFinalError(controller, encoder, "unknown", undefined, getUserFacingChatError(e));
      } finally {
        clearTimeout(firstTokenTimeoutId);
        if (abortReason === "timeout") recordLLMStreamAbortedTimeout();
        if (abortReason === "client") recordLLMStreamAbortedClient();
        if (budget && budget.tokensReserved > 0 && budget.supabase && budget.userId) {
          const usage = providerUsage ?? budget.usage;
          const tokensUsed =
            usage?.totalTokens ??
            (typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number"
              ? usage.inputTokens + usage.outputTokens
              : estimateTokensFromChars(totalChars));
          const hasProviderUsage = !!(
            usage?.totalTokens ??
            (typeof usage?.inputTokens === "number" && typeof usage?.outputTokens === "number")
          );
          if (hasProviderUsage && tokensUsed > 0) {
            reconcileBudgetWithUsage(
              budget.supabase,
              budget.userId,
              budget.tokensReserved,
              tokensUsed,
              budget.workspaceId
            ).catch(() => {});
            if (tokensUsed < budget.tokensReserved) {
              recordLLMBudgetRefunded(budget.tokensReserved - tokensUsed);
            }
          } else {
            const toRefund = Math.max(0, budget.tokensReserved - tokensUsed);
            if (toRefund > 0) {
              refundBudget(budget.supabase, budget.userId, toRefund, budget.workspaceId).catch(() => {});
              recordLLMBudgetRefunded(toRefund);
            }
          }
        }
      }
      await budget?.onComplete?.();
      safeClose(controller);
    },
  });
}
