/**
 * Phase 4: Abuse protection - per-user and per-workspace concurrent stream caps.
 * Uses Redis when REDIS_URL set, in-memory fallback.
 */

const MAX_STREAMS_PER_USER = parseInt(process.env.MAX_STREAMS_PER_USER ?? "5", 10) || 5;
const MAX_STREAMS_PER_WORKSPACE = parseInt(process.env.MAX_STREAMS_PER_WORKSPACE ?? "10", 10) || 10;

const STREAM_CAP_TTL_SEC = 300; // 5 min - stream should end by then

/** Lazy Redis client */
let redisClient: {
  incr: (k: string) => Promise<number>;
  decr: (k: string) => Promise<number>;
  expire: (k: string, s: number) => Promise<unknown>;
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
      decr: (k) => client.decr(k),
      expire: (k, s) => client.expire(k, s),
    };
    return redisClient;
  } catch {
    redisFailed = true;
    return null;
  }
}

/** In-memory fallback: Map<key, count> */
const inMemoryCounts = new Map<string, number>();

function inMemoryIncr(key: string): number {
  const n = (inMemoryCounts.get(key) ?? 0) + 1;
  inMemoryCounts.set(key, n);
  return n;
}

function inMemoryDecr(key: string): number {
  const n = Math.max(0, (inMemoryCounts.get(key) ?? 1) - 1);
  inMemoryCounts.set(key, n);
  if (n === 0) inMemoryCounts.delete(key);
  return n;
}

export type StreamCapResult = { ok: true } | { ok: false; reason: string };

/**
 * Try to acquire a stream slot. Returns { ok: false } if over cap.
 * Call releaseStreamSlot when stream ends.
 */
export async function acquireStreamSlot(
  userId: string,
  workspaceId?: string | null
): Promise<StreamCapResult> {
  const date = new Date().toISOString().slice(0, 10);
  const userKey = `streams:user:${userId}:${date}`;
  const wsKey = workspaceId ? `streams:ws:${workspaceId}:${date}` : null;

  const redis = await getRedis();

  if (redis) {
    try {
      const [userCount, wsCount] = await Promise.all([
        redis.incr(userKey),
        wsKey ? redis.incr(wsKey) : Promise.resolve(0),
      ]);
      if (userCount === 1) await redis.expire(userKey, STREAM_CAP_TTL_SEC);
      if (wsKey && wsCount === 1) await redis.expire(wsKey, STREAM_CAP_TTL_SEC);

      if (userCount > MAX_STREAMS_PER_USER) {
        await redis.decr(userKey);
        if (wsKey) await redis.decr(wsKey);
        return { ok: false, reason: `Maximum ${MAX_STREAMS_PER_USER} concurrent streams per user` };
      }
      if (wsKey && wsCount > MAX_STREAMS_PER_WORKSPACE) {
        await redis.decr(userKey);
        await redis.decr(wsKey);
        return { ok: false, reason: `Maximum ${MAX_STREAMS_PER_WORKSPACE} concurrent streams per workspace` };
      }
      return { ok: true };
    } catch {
      return { ok: true }; // Fail open on Redis error
    }
  }

  const userCount = inMemoryIncr(userKey);
  const wsCount = wsKey ? inMemoryIncr(wsKey) : 0;

  if (userCount > MAX_STREAMS_PER_USER) {
    inMemoryDecr(userKey);
    if (wsKey) inMemoryDecr(wsKey);
    return { ok: false, reason: `Maximum ${MAX_STREAMS_PER_USER} concurrent streams per user` };
  }
  if (wsKey && wsCount > MAX_STREAMS_PER_WORKSPACE) {
    inMemoryDecr(userKey);
    inMemoryDecr(wsKey);
    return { ok: false, reason: `Maximum ${MAX_STREAMS_PER_WORKSPACE} concurrent streams per workspace` };
  }
  return { ok: true };
}

/**
 * Release a stream slot. Call in finally when stream ends.
 */
export async function releaseStreamSlot(userId: string, workspaceId?: string | null): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const userKey = `streams:user:${userId}:${date}`;
  const wsKey = workspaceId ? `streams:ws:${workspaceId}:${date}` : null;

  const redis = await getRedis();
  if (redis) {
    try {
      await redis.decr(userKey);
      if (wsKey) await redis.decr(wsKey);
    } catch {
      // Ignore
    }
    return;
  }

  inMemoryDecr(userKey);
  if (wsKey) inMemoryDecr(wsKey);
}
