/**
 * API request rate limiting.
 * Uses in-memory store by default. Use Redis when REDIS_URL is set (for multi-instance).
 * Phase 1.4.2: Redis backend for production deployments.
 */

type Entry = { count: number; resetAt: number };

const inMemoryStore = new Map<string, Entry>();

const WINDOW_MS = 60 * 1000; // 1 minute

function getKey(identifier: string, prefix: string, windowStart?: number): string {
  const base = `ratelimit:${prefix}:${identifier}`;
  return windowStart != null ? `${base}:${windowStart}` : base;
}

function inMemoryCheck(key: string, limit: number): { ok: boolean; remaining: number } {
  const now = Date.now();
  const entry = inMemoryStore.get(key);

  if (!entry) {
    inMemoryStore.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, remaining: limit - 1 };
  }

  if (now >= entry.resetAt) {
    inMemoryStore.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, remaining: limit - 1 };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return { ok: false, remaining: 0 };
  }
  return { ok: true, remaining: limit - entry.count };
}

// Prune old entries periodically to avoid unbounded growth
let lastPrune = Date.now();
function pruneInMemoryStore() {
  const now = Date.now();
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [k, v] of inMemoryStore.entries()) {
    if (now >= v.resetAt) inMemoryStore.delete(k);
  }
}

/** Lazy Redis client - only created when REDIS_URL is set */
let redisClient: { incr: (k: string) => Promise<number>; pexpire: (k: string, ms: number) => Promise<unknown> } | null = null;
let redisFailed = false;

async function getRedisClient(): Promise<typeof redisClient> {
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
      pexpire: (k, ms) => client.pexpire(k, ms),
    };
    return redisClient;
  } catch {
    redisFailed = true;
    return null;
  }
}

async function redisCheck(key: string, limit: number): Promise<{ ok: boolean; remaining: number } | null> {
  const client = await getRedisClient();
  if (!client) return null;
  try {
    const count = await client.incr(key);
    if (count === 1) {
      await client.pexpire(key, WINDOW_MS);
    }
    return count <= limit ? { ok: true, remaining: Math.max(0, limit - count) } : { ok: false, remaining: 0 };
  } catch {
    return null;
  }
}

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; remaining: 0; retryAfter?: number };

/**
 * Check rate limit. Returns { ok: false } if over limit.
 * identifier: IP address, user ID, or combined (e.g. "ip:1.2.3.4" or "user:uuid")
 * prefix: route name (e.g. "chat-stream")
 * limit: max requests per window
 */
export async function checkRateLimit(
  identifier: string,
  prefix: string,
  limit: number
): Promise<RateLimitResult> {
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const key = getKey(identifier, prefix, windowStart);

  const redisResult = await redisCheck(key, limit);
  if (redisResult !== null) {
    if (redisResult.ok) return { ok: true as const, remaining: redisResult.remaining };
    return { ok: false, remaining: 0, retryAfter: Math.ceil(WINDOW_MS / 1000) };
  }

  pruneInMemoryStore();
  const memKey = getKey(identifier, prefix);
  const result = inMemoryCheck(memKey, limit);
  if (result.ok) return { ok: true as const, remaining: result.remaining };
  return { ok: false, remaining: 0, retryAfter: Math.ceil(WINDOW_MS / 1000) };
}

/**
 * Get rate-limit identifier from request: prefers user ID when authenticated, else IP.
 */
export function getRateLimitIdentifier(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0]?.trim() : request.headers.get("x-real-ip") ?? "unknown";
  return `ip:${ip}`;
}
