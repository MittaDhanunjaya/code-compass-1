/**
 * Phase 4.3.4: Centralized error wrapper.
 * Wrap errors, log safely, return user-facing message without leaking internals.
 */

export type SafeErrorOptions = {
  /** Request/trace ID for correlation */
  requestId?: string;
  /** User ID if authenticated */
  userId?: string;
  /** Log the full error (default: true in non-test) */
  log?: boolean;
  /** HTTP status code to suggest */
  statusCode?: number;
};

/** Errors that should not expose internal details to clients */
const SAFE_MESSAGE = "An unexpected error occurred. Please try again.";

/**
 * Wrap an error, log it, and return a safe user-facing message.
 * Use in API routes: catch (e) { return withSafeError(e, { requestId }); }
 */
export function withSafeError(
  error: unknown,
  options: SafeErrorOptions = {}
): { message: string; statusCode: number } {
  const { requestId, userId, log = process.env.NODE_ENV !== "test", statusCode = 500 } = options;

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
    console.error(JSON.stringify(payload));
  }

  // Never expose stack or internal details to client
  return {
    message: SAFE_MESSAGE,
    statusCode,
  };
}

/**
 * Create a JSON Response for API error handling.
 */
export function errorResponse(
  error: unknown,
  options: SafeErrorOptions & { statusCode?: number } = {}
): Response {
  const { message, statusCode } = withSafeError(error, options);
  return new Response(JSON.stringify({ error: message }), {
    status: options.statusCode ?? statusCode,
    headers: { "Content-Type": "application/json" },
  });
}
