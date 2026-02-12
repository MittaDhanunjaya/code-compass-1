/**
 * Phase 6.2: Centralized configuration constants.
 * Replaces scattered magic numbers and strings across routes, services, and lib.
 */

/** Agent execution and planning limits */
export const AGENT_CONFIG = {
  /** Max retry attempts for commands / self-debug */
  MAX_ATTEMPTS: 3,
  /** Request timeout for non-streaming LLM calls (ms) */
  TIMEOUT_MS: 120_000,
  /** Max file size for agent edits (1MB) */
  MAX_FILE_SIZE: 1024 * 1024,
  /** Max files in safe-edit mode before confirmation */
  SAFE_EDIT_MAX_FILES: 20,
  /** Max self-debug attempts before giving up */
  MAX_DEBUG_ATTEMPTS: 5,
  /** Command execution timeout (ms) */
  COMMAND_TIMEOUT_MS: 60_000,
  /** Server process command timeout (e.g. dev server) - 1 hour */
  SERVER_COMMAND_TIMEOUT_MS: 3600_000,
} as const;

/** Streaming and chunking limits */
export const STREAMING_CONFIG = {
  /** Upstream timeout for LLM streams (5 min) */
  STREAM_UPSTREAM_TIMEOUT_MS: 5 * 60 * 1000,
  /** Max total stream duration - hard cap (60s) */
  MAX_STREAM_DURATION_MS: 60_000,
  /** CoT (chain-of-thought) timeout when waiting for reasoning (ms) */
  COT_TIMEOUT_MS: 90_000,
} as const;

/** Indexing and chunking */
export const INDEXING_CONFIG = {
  /** Max chunk size in characters */
  MAX_CHUNK_SIZE: 5000,
  /** Embedding batch size */
  BATCH_SIZE: 10,
  /** Max concurrent embedding batches */
  MAX_CONCURRENT_BATCHES: 3,
  /** Delay between batches (ms) for rate limiting */
  DELAY_BETWEEN_BATCHES_MS: 100,
  /** Max retries for embedding batch failures */
  EMBEDDING_MAX_RETRIES: 2,
  /** Retry delay for embeddings (ms) */
  EMBEDDING_RETRY_DELAY_MS: 1000,
} as const;

/** LLM invoke retries */
export const LLM_CONFIG = {
  /** Max retries on rate limit / transient errors */
  MAX_RETRIES: 3,
  /** Initial backoff (ms); doubles each attempt */
  INITIAL_BACKOFF_MS: 1000,
  /** Default max output tokens per request */
  DEFAULT_MAX_TOKENS: 8192,
} as const;

/** Scope limits for agent plans */
export const SCOPE_CONFIG = {
  MAX_CONSERVATIVE_FILES: 5,
  MAX_CONSERVATIVE_LINES: 250,
  MAX_AGGRESSIVE_FILES: 15,
  MAX_AGGRESSIVE_LINES: 750,
} as const;
