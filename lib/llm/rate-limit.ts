/**
 * Rate limit / quota error detection for LLM providers.
 * Supabase RPC failure classification for provider fallback decisions.
 */

export type SupabaseRpcFailureKind = "timeout" | "budget_exceeded" | "infra";

/**
 * Classify Supabase/PostgREST RPC failures.
 * Used to decide whether provider fallback should trigger (it should NOT on infra).
 */
export function classifySupabaseRpcError(e: unknown): SupabaseRpcFailureKind {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if ((e as { code?: string })?.code === "BUDGET_EXCEEDED" || msg.includes("BUDGET_EXCEEDED") || lower.includes("token budget")) {
    return "budget_exceeded";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnaborted") ||
    /\b504\b|"code":\s*504/.test(msg)
  ) {
    return "timeout";
  }
  return "infra";
}

/**
 * Infra failures (DB down, connection refused, 5xx, PostgREST, etc).
 * Do NOT trigger provider fallback - the problem is our backend, not the LLM provider.
 */
export function isInfraFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  const code = (e as { code?: string })?.code;
  if (code === "BUDGET_EXCEEDED") return false;
  if (/\b429\b|"code":\s*429|\b404\b|"code":\s*404/.test(msg)) return false;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    lower.includes("connection refused") ||
    lower.includes("connection reset") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    /\b500\b|\b502\b|\b503\b|"code":\s*50[023]/.test(msg) ||
    lower.includes("postgres") ||
    lower.includes("pgrst") ||
    lower.includes("supabase")
  );
}

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

/**
 * Quota/rate-limit errors that should mark provider+model unavailable for this request.
 * Gemini RESOURCE_EXHAUSTED, OpenAI rate_limit_exceeded/insufficient_quota, OpenRouter 429.
 */
export function isQuotaExceededError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  const code = (e as { code?: string; error?: { code?: string } })?.code ?? (e as { error?: { code?: string } })?.error?.code;
  return (
    /\b429\b|"code":\s*429|"status":\s*429/.test(msg) ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    code === "RESOURCE_EXHAUSTED" ||
    lower.includes("quota exceeded") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("insufficient_quota") ||
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

/** Budget exceeded - do NOT fallback (user/workspace limit, not provider). */
export function isBudgetExceededError(e: unknown): boolean {
  return (e as { code?: string })?.code === "BUDGET_EXCEEDED";
}

/** Caller can fallback to another model when these are true. Excludes budget and infra errors. */
export function isFallbackableError(e: unknown): boolean {
  if (isBudgetExceededError(e)) return false;
  if (isInfraFailure(e)) return false;
  return isRateLimitError(e) || isEndpointNotFoundError(e) || isTimeoutError(e);
}
