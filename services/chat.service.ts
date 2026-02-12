/**
 * Phase 2.1.3: Chat service.
 * Extracts business logic from chat routes. Routes are thin: parse input → call service → return.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import { getProvider, getModelForProvider, PROVIDERS, PROVIDER_LABELS, type ProviderId } from "@/lib/llm/providers";
import { invokeChat } from "@/lib/llm/router";
import type { ChatMessage, ChatContext } from "@/lib/llm/types";
import type { SearchResult } from "@/lib/indexing/types";
import { detectErrorLogKind } from "@/lib/agent/error-log-utils";
import { loadRules, formatRulesForPrompt } from "@/lib/rules";
import { loadChatHistory, saveChatMessage } from "@/lib/chat-memory";
import { logger } from "@/lib/logger";
import { safeEnqueue, safeClose, shouldStopStream, STREAM_UPSTREAM_TIMEOUT_MS } from "@/lib/stream-utils";

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
        const key = `${m.role}:${m.content.slice(0, 50)}`;
        historyMap.set(key, true);
      });
      const newHistory = history.filter((h) => {
        const key = `${h.role}:${h.content.slice(0, 50)}`;
        return !historyMap.has(key) || !messages.some((m) => m.role === h.role && m.content === h.content);
      });
      messages = [...newHistory, ...messages];
    }
  }

  const keyResult = await getChatApiKey(supabase, userId, provider);
  if ("error" in keyResult) {
    throw new ChatServiceError(keyResult.error, keyResult.decryptFailed ? "decrypt_failed" : "no_key");
  }
  const { apiKey, providerId } = keyResult;

  let searchResults: SearchResult[] = [];
  const codebaseMatch =
    typeof lastMessage?.content === "string"
      ? lastMessage.content.match(/@codebase\s+"([^"]+)"/i) ?? lastMessage.content.match(/@codebase\s+(\S+)/i)
      : null;

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

  let modelOpt = getModelForProvider(providerId, model);
  if (modelOpt == null || modelOpt === "") {
    if (providerId === "openrouter") modelOpt = "openrouter/free";
    else if (providerId === "gemini") modelOpt = "gemini-2.0-flash";
    else if (providerId === "openai") modelOpt = "gpt-4o-mini";
    else if (providerId === "perplexity") modelOpt = "sonar";
    else if (providerId === "ollama") modelOpt = "llama3.2";
  }

  const { content, usage } = await invokeChat({
    messages: enhancedMessages,
    apiKey,
    providerId,
    model: modelOpt ?? undefined,
    context,
    task: "chat",
    userId,
    workspaceId: context?.workspaceId ?? undefined,
    supabase,
  });

  if (workspaceId) {
    const lastUserContent = typeof lastMessage?.content === "string" ? lastMessage.content : "";
    const rt = runType ?? "chat";
    try {
      await saveChatMessage(supabase, workspaceId, userId, "user", lastUserContent, { runType: rt });
      await saveChatMessage(supabase, workspaceId, userId, "assistant", content, { runType: rt });
    } catch (e) {
      logger.warn({ event: "save_chat_history_failed", workspaceId, userId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const kind = detectErrorLogKind(typeof lastMessage?.content === "string" ? lastMessage.content : "");
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
};

/**
 * Create a streaming chat response. Tries providers in order, emits error as [Error: ...] on failure.
 * Caller must resolve providerKeys via getChatProviderKeys before calling.
 */
export function createChatStream(input: ChatStreamInput): ReadableStream<Uint8Array> {
  const { messages, context, model, providerKeys, request } = input;

  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const startTime = Date.now();

      try {
        let lastError: unknown = null;
        for (const { providerId, apiKey } of providerKeys) {
          if (shouldStopStream(request, startTime, STREAM_UPSTREAM_TIMEOUT_MS)) break;
          try {
            const p = getProvider(providerId);
            const modelOpt = getModelForProvider(providerId, model);
            for await (const chunk of p.stream(messages, apiKey, { context, model: modelOpt })) {
              if (shouldStopStream(request, startTime, STREAM_UPSTREAM_TIMEOUT_MS)) break;
              safeEnqueue(controller, encoder, chunk);
            }
            lastError = null;
            break;
          } catch (e) {
            lastError = e;
            if (!isRateLimitError(e) && !isInvalidModelError(e)) {
              safeEnqueue(controller, encoder, `[Error: ${getUserFacingChatError(e)}]`);
              break;
            }
          }
        }
        if (lastError != null && (isRateLimitError(lastError) || isInvalidModelError(lastError))) {
          safeEnqueue(
            controller,
            encoder,
            `[Error: ${getUserFacingChatError(lastError)}. Try selecting a different provider (e.g. OpenAI) in the dropdown above if you have an API key.]`
          );
        }
      } catch (e) {
        safeEnqueue(controller, encoder, `[Error: ${getUserFacingChatError(e)}]`);
      }
      safeClose(controller);
    },
  });
}
