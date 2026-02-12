/**
 * Phase 6.3: Generic retry handler with exponential backoff.
 * Wraps LLM and other async calls to handle rate limits and transient network errors.
 */

import { LLM_CONFIG } from "@/lib/config/constants";

export type RetryOptions = {
  maxAttempts?: number;
  initialBackoffMs?: number;
  /** Return true if error is retryable (e.g. rate limit, network) */
  isRetryable?: (error: unknown) => boolean;
};

const defaultIsRetryable = (): boolean => true;

/**
 * Execute an async function with retries and exponential backoff.
 * @param fn Async function to execute
 * @param options Retry options
 * @returns Result of fn
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = LLM_CONFIG.MAX_RETRIES,
    initialBackoffMs = LLM_CONFIG.INITIAL_BACKOFF_MS,
    isRetryable = defaultIsRetryable,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts - 1 && isRetryable(e)) {
        const backoff = initialBackoffMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      } else {
        throw e;
      }
    }
  }
  throw lastError;
}
