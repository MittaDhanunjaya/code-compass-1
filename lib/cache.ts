/**
 * In-memory caching layer for performance optimization.
 * Phase 6.1.4: getOrSet with Redis when REDIS_URL set, in-memory fallback.
 * Caches Tab completions, search results, embeddings, and file tree.
 */

import { createHash } from "crypto";

type CacheEntry<T> = {
  value: T;
  timestamp: number;
  ttl: number; // Time to live in milliseconds
};

class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key: string, value: T, ttl: number = 60000): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

/** Lazy Redis client for cache - only created when REDIS_URL is set */
let redisCacheClient: {
  get: (key: string) => Promise<string | null>;
  setex: (key: string, seconds: number, value: string) => Promise<unknown>;
  del: (key: string) => Promise<number>;
} | null = null;
let redisCacheFailed = false;

async function getRedisCacheClient(): Promise<typeof redisCacheClient> {
  if (redisCacheClient) return redisCacheClient;
  if (redisCacheFailed) return null;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const Redis = (await import("ioredis")).default;
    const client = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: true });
    await client.connect();
    redisCacheClient = {
      get: (k) => client.get(k),
      setex: (k, s, v) => client.setex(k, s, v),
      del: (k) => client.del(k),
    };
    return redisCacheClient;
  } catch {
    redisCacheFailed = true;
    return null;
  }
}

const inMemoryStore = new Map<string, { value: string; expiresAt: number }>();

function inMemoryGet(key: string): string | null {
  const entry = inMemoryStore.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) inMemoryStore.delete(key);
    return null;
  }
  return entry.value;
}

function inMemorySet(key: string, value: string, ttlMs: number): void {
  inMemoryStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function inMemoryDelete(key: string): void {
  inMemoryStore.delete(key);
}

/**
 * Get or set a cached value. Uses Redis when REDIS_URL is set, else in-memory.
 * @param key Cache key
 * @param ttlMs TTL in milliseconds
 * @param fn Async function to compute value when cache miss
 * @returns Cached or computed value
 */
export async function getOrSet<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options?: { serialize?: (v: T) => string; deserialize?: (s: string) => T }
): Promise<T> {
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = options?.deserialize ?? (JSON.parse as (s: string) => T);

  const redis = await getRedisCacheClient();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) return deserialize(cached);
    } catch {
      // Fall through to compute
    }
    const value = await fn();
    try {
      const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
      await redis.setex(key, ttlSec, serialize(value));
    } catch {
      // Ignore set failure
    }
    return value;
  }

  const memCached = inMemoryGet(key);
  if (memCached) return deserialize(memCached);
  const value = await fn();
  inMemorySet(key, serialize(value), ttlMs);
  return value;
}

/**
 * Get or set with metadata (whether value came from cache).
 * Used when caller needs to skip side effects (e.g. token usage) on cache hit.
 */
export async function getOrSetWithMeta<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  options?: { serialize?: (v: T) => string; deserialize?: (s: string) => T }
): Promise<{ value: T; cached: boolean }> {
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = options?.deserialize ?? (JSON.parse as (s: string) => T);

  const redis = await getRedisCacheClient();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) return { value: deserialize(cached), cached: true };
    } catch {
      // Fall through to compute
    }
    const value = await fn();
    try {
      const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
      await redis.setex(key, ttlSec, serialize(value));
    } catch {
      // Ignore set failure
    }
    return { value, cached: false };
  }

  const memCached = inMemoryGet(key);
  if (memCached) return { value: deserialize(memCached), cached: true };
  const value = await fn();
  inMemorySet(key, serialize(value), ttlMs);
  return { value, cached: false };
}

/**
 * Invalidate a cache key (for getOrSet). Use for file tree when files change.
 */
export async function invalidateCache(key: string): Promise<void> {
  inMemoryDelete(key);
  const redis = await getRedisCacheClient();
  if (redis) {
    try {
      await redis.del(key);
    } catch {
      // Ignore Redis delete failure
    }
  }
}

/** Simple hash for cache keys (e.g. instruction + scopeMode + model) */
export function hashForCache(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

// Cache instances
export const tabCompletionCache = new SimpleCache<string>(500); // 500 entries, 30s TTL
export const searchCache = new SimpleCache<{ results: unknown[]; count: number }>(200); // 200 entries, 5min TTL
export const embeddingCache = new SimpleCache<number[][]>(100); // 100 entries, 1hr TTL

/**
 * Generate cache key for Tab completion.
 */
export function getTabCompletionKey(
  workspaceId: string,
  filePath: string,
  prefix: string,
  suffix: string
): string {
  // Use hash of prefix/suffix for key (last 100 chars to keep key reasonable)
  const prefixHash = prefix.slice(-100).replace(/\s+/g, " ").trim();
  const suffixHash = suffix.slice(0, 50).replace(/\s+/g, " ").trim();
  return `tab:${workspaceId}:${filePath}:${prefixHash}:${suffixHash}`;
}

/**
 * Generate cache key for search.
 */
export function getSearchKey(
  workspaceId: string,
  query: string,
  limit: number,
  semantic: boolean
): string {
  const normalizedQuery = query.toLowerCase().trim().slice(0, 100);
  return `search:${workspaceId}:${normalizedQuery}:${limit}:${semantic}`;
}

/**
 * Generate cache key for embeddings.
 */
export function getEmbeddingKey(texts: string[]): string {
  // Use hash of concatenated texts (first 500 chars total)
  const combined = texts.join("\n").slice(0, 500);
  return `embed:${combined.length}:${combined.slice(0, 50)}`;
}
