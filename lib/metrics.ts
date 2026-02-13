/**
 * Phase 12.2: In-memory performance metrics for observability.
 * Used by /api/metrics and structured logging.
 */

import { logger } from "@/lib/logger";

const MAX_SAMPLES = 100;

const llmLatencySamples: number[] = [];
const agentPlanDurationSamples: number[] = [];
const agentExecuteDurationSamples: number[] = [];
let llmRequestCount = 0;
let agentPlanCount = 0;
let agentExecuteCount = 0;

function pushSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

/**
 * Record LLM API latency (ms).
 */
export function recordLLMLatency(latencyMs: number): void {
  if (process.env.NODE_ENV === "test") return;
  llmRequestCount++;
  pushSample(llmLatencySamples, latencyMs);
}

/** Budget metrics for observability. */
let llmBudgetReservedCount = 0;
let llmBudgetRefundedCount = 0;
let llmBudgetExceededCount = 0;
let llmStreamAbortedTimeoutCount = 0;
let llmStreamAbortedClientCount = 0;

export function recordLLMBudgetReserved(tokens: number): void {
  if (process.env.NODE_ENV === "test") return;
  llmBudgetReservedCount++;
  logger.info({ event: "llm_budget_reserved", tokens });
}

export function recordLLMBudgetRefunded(tokens: number): void {
  if (process.env.NODE_ENV === "test") return;
  llmBudgetRefundedCount++;
  logger.info({ event: "llm_budget_refunded", tokens });
}

export function recordLLMBudgetExceeded(): void {
  if (process.env.NODE_ENV === "test") return;
  llmBudgetExceededCount++;
  logger.info({ event: "llm_budget_exceeded" });
}

export function recordLLMStreamAbortedTimeout(): void {
  if (process.env.NODE_ENV === "test") return;
  llmStreamAbortedTimeoutCount++;
  logger.info({ event: "llm_stream_aborted_timeout" });
}

export function recordLLMStreamAbortedClient(): void {
  if (process.env.NODE_ENV === "test") return;
  llmStreamAbortedClientCount++;
  logger.info({ event: "llm_stream_aborted_client" });
}

/** Phase 3: Refund and RPC metrics. */
let refundFailureCount = 0;
let refundQueueEnqueuedCount = 0;
let budgetEnforcementFailureCount = 0;
const supabaseRpcLatencySamples: number[] = [];

export function recordRefundFailure(): void {
  if (process.env.NODE_ENV === "test") return;
  refundFailureCount++;
  logger.info({ event: "refund_failure" });
}

export function recordRefundQueueEnqueued(): void {
  if (process.env.NODE_ENV === "test") return;
  refundQueueEnqueuedCount++;
  logger.info({ event: "refund_queue_enqueued" });
}

export function recordBudgetEnforcementFailure(): void {
  if (process.env.NODE_ENV === "test") return;
  budgetEnforcementFailureCount++;
  logger.info({ event: "budget_enforcement_failure" });
}

export function recordSupabaseRpcLatency(latencyMs: number): void {
  if (process.env.NODE_ENV === "test") return;
  pushSample(supabaseRpcLatencySamples, latencyMs);
}

/** Phase 4: Reconciliation drift (actual - reserved). Positive = under-refunded, negative = over-refunded. */
let reconciliationDriftSamples: number[] = [];
let reconciliationChargeFailureCount = 0;

export function recordReconciliationDrift(drift: number): void {
  if (process.env.NODE_ENV === "test") return;
  pushSample(reconciliationDriftSamples, drift);
  if (drift !== 0) {
    logger.info({ event: "llm_reconciliation_drift", drift, tokens: Math.abs(drift) });
  }
}

export function recordReconciliationChargeFailure(): void {
  if (process.env.NODE_ENV === "test") return;
  reconciliationChargeFailureCount++;
  logger.warn({ event: "reconciliation_charge_failure" });
}

/**
 * Record agent plan phase duration (ms).
 */
export function recordAgentPlanDuration(ms: number): void {
  if (process.env.NODE_ENV === "test") return;
  agentPlanCount++;
  pushSample(agentPlanDurationSamples, ms);
}

/**
 * Record agent execute phase duration (ms).
 */
export function recordAgentExecuteDuration(ms: number): void {
  if (process.env.NODE_ENV === "test") return;
  agentExecuteCount++;
  pushSample(agentExecuteDurationSamples, ms);
}

/** Phase 12.2.3: Threshold (ms) for slow file ops to log. */
const SLOW_FILE_OP_MS = 2000;

const fileOpDurationSamples: number[] = [];
let slowFileOpCount = 0;

/**
 * Record file read/write operation duration. Logs when slow.
 */
export function recordFileOpDuration(op: string, durationMs: number, path?: string): void {
  if (process.env.NODE_ENV === "test") return;
  pushSample(fileOpDurationSamples, durationMs);
  if (durationMs >= SLOW_FILE_OP_MS) {
    slowFileOpCount++;
    logger.warn({
      event: "slow_file_op",
      op,
      durationMs,
      path,
    });
  }
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function p50(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)] ?? 0;
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
}

/** Phase 3: Alert thresholds (for monitoring integrations). */
export const METRICS_ALERT_THRESHOLDS = {
  refundFailureCount: 10,
  supabaseRpcLatencyP95Ms: 5000,
  budgetEnforcementFailureCount: 5,
} as const;

export type MetricsSnapshot = {
  llm: {
    requestCount: number;
    latencyMs: { avg: number; p50: number; p95: number; sampleCount: number };
    budgetReservedCount: number;
    budgetRefundedCount: number;
    budgetExceededCount: number;
    streamAbortedTimeoutCount: number;
    streamAbortedClientCount: number;
  };
  budget: {
    refundFailureCount: number;
    refundQueueEnqueuedCount: number;
    budgetEnforcementFailureCount: number;
    supabaseRpcLatencyP95Ms: number;
    reconciliationChargeFailureCount: number;
    reconciliationDriftP95: number;
    alertThresholds: typeof METRICS_ALERT_THRESHOLDS;
  };
  agent: {
    planCount: number;
    planDurationMs: { avg: number; p50: number; p95: number; sampleCount: number };
    executeCount: number;
    executeDurationMs: { avg: number; p50: number; p95: number; sampleCount: number };
  };
  fileOps: {
    slowOpCount: number;
    durationMs: { avg: number; p50: number; p95: number; sampleCount: number };
  };
  timestamp: string;
};

/**
 * Get current metrics snapshot for /api/metrics.
 */
export function getMetricsSnapshot(): MetricsSnapshot {
  return {
    llm: {
      requestCount: llmRequestCount,
      latencyMs: {
        avg: avg(llmLatencySamples),
        p50: p50(llmLatencySamples),
        p95: p95(llmLatencySamples),
        sampleCount: llmLatencySamples.length,
      },
      budgetReservedCount: llmBudgetReservedCount,
      budgetRefundedCount: llmBudgetRefundedCount,
      budgetExceededCount: llmBudgetExceededCount,
      streamAbortedTimeoutCount: llmStreamAbortedTimeoutCount,
      streamAbortedClientCount: llmStreamAbortedClientCount,
    },
    budget: {
      refundFailureCount,
      refundQueueEnqueuedCount,
      budgetEnforcementFailureCount,
      supabaseRpcLatencyP95Ms: p95(supabaseRpcLatencySamples),
      reconciliationChargeFailureCount,
      reconciliationDriftP95: p95(reconciliationDriftSamples),
      alertThresholds: METRICS_ALERT_THRESHOLDS,
    },
    agent: {
      planCount: agentPlanCount,
      planDurationMs: {
        avg: avg(agentPlanDurationSamples),
        p50: p50(agentPlanDurationSamples),
        p95: p95(agentPlanDurationSamples),
        sampleCount: agentPlanDurationSamples.length,
      },
      executeCount: agentExecuteCount,
      executeDurationMs: {
        avg: avg(agentExecuteDurationSamples),
        p50: p50(agentExecuteDurationSamples),
        p95: p95(agentExecuteDurationSamples),
        sampleCount: agentExecuteDurationSamples.length,
      },
    },
    fileOps: {
      slowOpCount: slowFileOpCount,
      durationMs: {
        avg: avg(fileOpDurationSamples),
        p50: p50(fileOpDurationSamples),
        p95: p95(fileOpDurationSamples),
        sampleCount: fileOpDurationSamples.length,
      },
    },
    timestamp: new Date().toISOString(),
  };
}
