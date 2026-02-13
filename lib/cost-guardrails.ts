/**
 * Phase 4: Cost guardrails.
 * - Per-request cost ceiling (USD-based)
 * - Alert when user burns > X% of daily budget in < Y minutes
 */

import { getDailyLimit } from "@/lib/token-budget";
import { logger } from "@/lib/logger";

/** Approximate USD per 1K tokens (input/output avg). Conservative for gpt-4o-mini. */
const DEFAULT_USD_PER_1K_TOKENS = 0.002;
const PER_REQUEST_COST_CEILING_USD = parseFloat(process.env.PER_REQUEST_COST_CEILING_USD ?? "0.50") || 0.5;
const BURN_RATE_ALERT_PERCENT = parseInt(process.env.BURN_RATE_ALERT_PERCENT ?? "50", 10) || 50;
const BURN_RATE_ALERT_WINDOW_MIN = parseInt(process.env.BURN_RATE_ALERT_WINDOW_MIN ?? "5", 10) || 5;

/** Lazy Redis for burn-rate tracking */
let redisClient: {
  incr: (k: string) => Promise<number>;
  incrby: (k: string, n: number) => Promise<number>;
  expire: (k: string, s: number) => Promise<unknown>;
  get: (k: string) => Promise<string | null>;
} | null = null;
let redisFailed = false;

async function getRedis(): Promise<typeof redisClient> {
  if (redisClient) return redisClient;
  if (redisFailed) return null;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const Redis = (await import("ioredis")).default;
    const client = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });
    await client.connect();
    redisClient = {
      incr: (k) => client.incr(k),
      incrby: (k, n) => client.incrby(k, n),
      expire: (k, s) => client.expire(k, s),
      get: (k) => client.get(k),
    };
    return redisClient;
  } catch {
    redisFailed = true;
    return null;
  }
}

/** Estimate USD cost from token count. */
export function estimateCostUsd(tokens: number): number {
  const rate = parseFloat(process.env.USD_PER_1K_TOKENS ?? String(DEFAULT_USD_PER_1K_TOKENS)) || DEFAULT_USD_PER_1K_TOKENS;
  return (tokens / 1000) * rate;
}

/**
 * Check per-request cost ceiling. Throws if estimated cost exceeds ceiling.
 */
export function checkPerRequestCostCeiling(tokensReserved: number): void {
  const cost = estimateCostUsd(tokensReserved);
  if (cost > PER_REQUEST_COST_CEILING_USD) {
    throw new Error(
      `Request cost ($${cost.toFixed(4)}) exceeds maximum ($${PER_REQUEST_COST_CEILING_USD}). Reduce token usage.`
    );
  }
}

/**
 * Record tokens used and alert if burn rate exceeds threshold.
 * Call after successful reservation or reconciliation.
 */
export async function recordTokenBurnAndAlert(
  userId: string,
  tokens: number,
  date: string
): Promise<void> {
  if (tokens <= 0) return;
  const limit = getDailyLimit();
  const thresholdTokens = Math.floor((limit * BURN_RATE_ALERT_PERCENT) / 100);
  const windowSec = BURN_RATE_ALERT_WINDOW_MIN * 60;
  const key = `burn:${userId}:${date}:${Math.floor(Date.now() / (windowSec * 1000))}`;

  const redis = await getRedis();
  if (!redis) return;
  try {
    const count = await redis.incrby(key, tokens);
    if (count === tokens) {
      await redis.expire(key, windowSec * 2);
    }
    if (count >= thresholdTokens) {
      logger.warn({
        event: "cost_guardrail_burn_rate_alert",
        userId,
        tokensInWindow: count,
        thresholdTokens,
        percentOfDaily: BURN_RATE_ALERT_PERCENT,
        windowMinutes: BURN_RATE_ALERT_WINDOW_MIN,
      });
    }
  } catch {
    // Ignore
  }
}
