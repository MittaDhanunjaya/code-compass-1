/**
 * Rate limit / quota error detection for LLM providers.
 */

export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    /\b429\b|"code":\s*429|"status":\s*429/.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("rate limit exceeded") ||
    lower.includes("daily limit") ||
    lower.includes("too many requests")
  );
}

/** 404 / endpoint not found (e.g. OpenRouter model ID no longer available). */
export function isEndpointNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /\b404\b|"code":\s*404|no endpoints found|endpoint.*not found/i.test(msg);
}

/** Timeout / request took too long. */
export function isTimeoutError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnaborted") ||
    /\b504\b|"code":\s*504/.test(msg)
  );
}

/** Caller can fallback to another model when these are true. */
export function isFallbackableError(e: unknown): boolean {
  return isRateLimitError(e) || isEndpointNotFoundError(e) || isTimeoutError(e);
}
