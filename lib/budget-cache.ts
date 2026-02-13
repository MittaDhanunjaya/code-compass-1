/**
 * Phase 4: Redis shadow cache for budget availability.
 * Fail fast when cache shows zero budget to avoid Supabase hot-path calls.
 * Redis optional - fallback to Supabase only when REDIS_URL not set.
 * Does NOT weaken atomic enforcement; Supabase remains source of truth.
 */

const BUDGET_EXHAUSTED_TTL_SEC = 30;
const CACHE_PREFIX = "budget:exhausted:";

/** Lazy Redis client - only created when REDIS_URL is set */
let redisClient: { get: (k: string) => Promise<string | null>; setex: (k: string, s: number, v: string) => Promise<unknown> } | null = null;
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
      get: (k) => client.get(k),
      setex: (k, s, v) => client.setex(k, s, v),
    };
    return redisClient;
  } catch {
    redisFailed = true;
    return null;
  }
}

function cacheKey(userId: string, date: string, scope: "user" | "workspace", workspaceId?: string | null): string {
  if (scope === "workspace" && workspaceId) {
    return `${CACHE_PREFIX}w:${workspaceId}:${date}`;
  }
  return `${CACHE_PREFIX}u:${userId}:${date}`;
}

/**
 * Check if cache indicates budget exhausted. Returns true only when we have a cache HIT with exhausted.
 * When true, fail fast without calling Supabase.
 */
export async function isBudgetExhaustedCached(
  userId: string,
  date: string,
  scope: "user" | "workspace",
  workspaceId?: string | null
): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) return false;
  try {
    const key = cacheKey(userId, date, scope, workspaceId);
    const val = await redis.get(key);
    return val === "1";
  } catch {
    return false;
  }
}

/**
 * Set cache when Supabase returns BUDGET_EXCEEDED. Enables fail-fast on retries.
 */
export async function setBudgetExhaustedCache(
  userId: string,
  date: string,
  scope: "user" | "workspace",
  workspaceId?: string | null
): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  try {
    const key = cacheKey(userId, date, scope, workspaceId);
    await redis.setex(key, BUDGET_EXHAUSTED_TTL_SEC, "1");
  } catch {
    // Ignore cache set failure
  }
}
