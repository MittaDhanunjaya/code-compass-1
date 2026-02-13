/**
 * Phase 4.3.4: Centralized error wrapper.
 * Phase 7.1: Error categorization and user-friendly messages.
 * Phase 12.1: Use structured logger instead of console.
 */

import { logger } from "@/lib/logger";

/** Typed error code for UI when all AI providers fail (quota/rate-limit). */
export const AI_TEMPORARILY_UNAVAILABLE = "AI_TEMPORARILY_UNAVAILABLE" as const;

/** All models exhausted (quota/rate-limit). UI should prompt model switch. */
export const ALL_MODELS_EXHAUSTED = "ALL_MODELS_EXHAUSTED" as const;

/** Planner failed to produce valid JSON/schema after retries. */
export const AGENT_PROTOCOL_FAILURE = "AGENT_PROTOCOL_FAILURE" as const;

export function isAiTemporarilyUnavailableError(e: unknown): boolean {
  return (e as { code?: string })?.code === AI_TEMPORARILY_UNAVAILABLE;
}

export function isAllModelsExhaustedError(e: unknown): boolean {
  return (e as { code?: string })?.code === ALL_MODELS_EXHAUSTED;
}

export type ErrorCategory = "auth" | "rate_limit" | "network" | "validation" | "unknown";

/** Production observability: classify for incident triage. */
export type ErrorClass = "user_error" | "provider_error" | "internal_error";

export function classifyErrorClass(error: unknown): ErrorClass {
  const e = error as {
    code?: string;
    statusCode?: number;
    status?: number;
    type?: string;
    error?: { code?: string; type?: string };
  };
  const status = e?.status ?? e?.statusCode;
  const code = e?.code ?? e?.error?.code;
  const type = e?.type ?? e?.error?.type;

  if (code === "BUDGET_EXCEEDED" || status === 429) return "user_error";
  if (status === 401 || code === "invalid_api_key" || type === "invalid_request_error") return "user_error";
  if (
    status === 429 ||
    status === 503 ||
    code === "rate_limit_exceeded" ||
    code === "insufficient_quota" ||
    code === "resource_exhausted" ||
    type === "rate_limit_error"
  )
    return "provider_error";
  if (status === 408 || status === 504 || code === "timeout") return "provider_error";

  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (msg.includes("rate limit") || msg.includes("quota") || /\b429\b/.test(msg) || msg.includes("timeout"))
    return "provider_error";
  if (msg.includes("auth") || /\b401\b/.test(msg) || msg.includes("invalid") || msg.includes("validation"))
    return "user_error";
  return "internal_error";
}

export type SafeErrorOptions = {
  /** Request/trace ID for correlation */
  requestId?: string;
  /** User ID if authenticated */
  userId?: string;
  /** Log the full error (default: true in non-test) */
  log?: boolean;
  /** HTTP status code to suggest */
  statusCode?: number;
  /** Retry-After in seconds (for rate limit) */
  retryAfter?: number;
};

/** Errors that should not expose internal details to clients */
const SAFE_MESSAGE = "An unexpected error occurred. Please try again.";

/**
 * Phase 7.1: Map status code and category to user-friendly message.
 */
export function getUserFriendlyMessage(
  category: ErrorCategory,
  opts?: { retryAfterSeconds?: number }
): string {
  switch (category) {
    case "auth":
      return "Please re-authenticate to continue.";
    case "rate_limit": {
      const mins = opts?.retryAfterSeconds
        ? Math.max(1, Math.ceil(opts.retryAfterSeconds / 60))
        : 1;
      return `Please wait ${mins} minute${mins !== 1 ? "s" : ""} before trying again.`;
    }
    case "network":
      return "Check your connection and try again.";
    case "validation":
      return "Please check your input and try again.";
    default:
      return SAFE_MESSAGE;
  }
}

/**
 * Phase 7.1: Classify error from status code (and optional message).
 */
export function classifyError(statusCode: number, _message?: string): ErrorCategory {
  if (statusCode === 401) return "auth";
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 400 || statusCode === 422) return "validation";
  if (statusCode === 408 || statusCode === 504 || statusCode === 503) return "network";
  return "unknown";
}

/**
 * Phase 7.1.5: Client-side helper to get display message from API error.
 * Use when you have statusCode/retryAfter from the response.
 */
export function parseApiErrorForDisplay(
  message: string,
  statusCode?: number,
  retryAfter?: number
): string {
  if (statusCode == null) return message;
  const category = classifyError(statusCode);
  if (category !== "unknown") {
    return getUserFriendlyMessage(category, {
      retryAfterSeconds: retryAfter ?? undefined,
    });
  }
  return message;
}

/**
 * Map common LLM/OpenRouter errors to user-friendly messages.
 * Does not override app errors (BUDGET_EXCEEDED, etc.).
 */
export function getLLMUserFriendlyError(error: unknown, provider?: string): string {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  const code = (error as { code?: string })?.code;
  const status = (error as { status?: number; statusCode?: number })?.status ?? (error as { status?: number; statusCode?: number })?.statusCode;

  if (code === "BUDGET_EXCEEDED" || msg.includes("token budget") || msg.includes("daily token limit")) {
    return msg;
  }
  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("quota exceeded")) {
    return "OpenRouter rate limit reached. Free models: 20 requests/min. Wait a minute or add credits at openrouter.ai.";
  }
  if (status === 401 || lower.includes("invalid api key") || lower.includes("authentication") || lower.includes("incorrect api key")) {
    return "Invalid API key. Check your key in Settings → API Keys or get a new one at openrouter.ai/keys.";
  }
  if (status === 404 || lower.includes("not found") || lower.includes("model") && lower.includes("invalid")) {
    return "Model not found. Try openrouter/free or check the model ID in Settings.";
  }
  if (status === 503 || lower.includes("overloaded") || lower.includes("capacity")) {
    return "OpenRouter is overloaded. Try again in a minute.";
  }
  if (msg === "LLM request failed" || msg.length < 5) {
    return "Request failed. Check your API key in Settings → API Keys, or try a different provider (e.g. Gemini).";
  }
  return msg;
}

/**
 * Wrap an error, log it, and return a safe user-facing message.
 * Phase 7.1: For 401/429/400/408/504/503, returns user-friendly message.
 */
export function withSafeError(
  error: unknown,
  options: SafeErrorOptions = {}
): { message: string; statusCode: number; retryAfter?: number } {
  const {
    requestId,
    userId,
    log = process.env.NODE_ENV !== "test",
    statusCode = 500,
    retryAfter,
  } = options;

  const err = error instanceof Error ? error : new Error(String(error));
  const payload = {
    event: "api_error",
    message: err.message,
    name: err.name,
    requestId,
    userId,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  };

  if (log) {
    logger.error(payload as Record<string, unknown>);
  }

  const category = classifyError(statusCode, err.message);
  const message =
    category !== "unknown"
      ? getUserFriendlyMessage(category, { retryAfterSeconds: retryAfter })
      : SAFE_MESSAGE;

  return {
    message,
    statusCode,
    ...(retryAfter != null && { retryAfter }),
  };
}

/**
 * Create a JSON Response for API error handling.
 * Phase 7.1: Adds Retry-After header for 429 when retryAfter provided.
 * Maps AI_TEMPORARILY_UNAVAILABLE to 503 with typed code for UI.
 */
export function errorResponse(
  error: unknown,
  options: SafeErrorOptions & { statusCode?: number } = {}
): Response {
  if (isAiTemporarilyUnavailableError(error)) {
    return new Response(
      JSON.stringify({
        error: "AI temporarily unavailable. Try again in a moment.",
        code: AI_TEMPORARILY_UNAVAILABLE,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  const exhausted = error as Error & { code?: string; recommendedProviders?: string[]; recommendedModels?: string[] };
  if (exhausted?.code === ALL_MODELS_EXHAUSTED) {
    return new Response(
      JSON.stringify({
        error: "All available AI models are currently rate-limited or out of quota.",
        code: ALL_MODELS_EXHAUSTED,
        recommendedProviders: exhausted.recommendedProviders ?? [],
        recommendedModels: exhausted.recommendedModels ?? [],
        userAction: "switch_model_or_add_api_key",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  const { message, statusCode, retryAfter } = withSafeError(error, options);
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(retryAfter != null &&
      statusCode === 429 && { "Retry-After": String(retryAfter) }),
  };
  return new Response(JSON.stringify({ error: message }), {
    status: options.statusCode ?? statusCode,
    headers,
  });
}
