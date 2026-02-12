/**
 * Phase 4.3.4: Centralized error wrapper.
 * Phase 7.1: Error categorization and user-friendly messages.
 * Phase 12.1: Use structured logger instead of console.
 */

import { logger } from "@/lib/logger";

export type ErrorCategory = "auth" | "rate_limit" | "network" | "validation" | "unknown";

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
 */
export function errorResponse(
  error: unknown,
  options: SafeErrorOptions & { statusCode?: number } = {}
): Response {
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
