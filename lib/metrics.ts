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

export type MetricsSnapshot = {
  llm: {
    requestCount: number;
    latencyMs: { avg: number; p50: number; p95: number; sampleCount: number };
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
