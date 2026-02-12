/**
 * In-memory caching layer for performance optimization.
 * Caches Tab completions, search results, and embeddings.
 */

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

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
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
