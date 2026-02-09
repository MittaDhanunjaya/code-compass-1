/**
 * Persistent cache using Supabase database.
 * Survives server restarts and provides TTL support.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type CacheEntry<T> = {
  key: string;
  value: T;
  ttl: number; // Time to live in milliseconds
  expiresAt: number; // Timestamp when entry expires
};

/**
 * Persistent cache backed by database.
 */
export class PersistentCache<T> {
  private supabase: SupabaseClient;
  private tableName: string;
  private inMemoryCache: Map<string, CacheEntry<T>>;
  private maxMemorySize: number;

  constructor(
    supabase: SupabaseClient,
    tableName: string = "cache_entries",
    maxMemorySize: number = 1000
  ) {
    this.supabase = supabase;
    this.tableName = tableName;
    this.inMemoryCache = new Map();
    this.maxMemorySize = maxMemorySize;
  }

  /**
   * Get value from cache (checks memory first, then database).
   */
  async get(key: string): Promise<T | null> {
    // Check in-memory cache first
    const memoryEntry = this.inMemoryCache.get(key);
    if (memoryEntry && memoryEntry.expiresAt > Date.now()) {
      return memoryEntry.value;
    }

    // Check database
    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .select("value, expires_at")
        .eq("key", key)
        .single();

      if (error || !data) {
        return null;
      }

      // Check if expired
      const expiresAt = new Date(data.expires_at).getTime();
      if (expiresAt <= Date.now()) {
        // Delete expired entry
        await this.supabase
          .from(this.tableName)
          .delete()
          .eq("key", key);
        return null;
      }

      // Parse value (stored as JSON)
      const value = JSON.parse(data.value) as T;

      // Update in-memory cache
      this.setMemory(key, value, expiresAt - Date.now());

      return value;
    } catch (error) {
      console.error("Cache get error:", error);
      return null;
    }
  }

  /**
   * Set value in cache (both memory and database).
   */
  async set(key: string, value: T, ttl: number = 60000): Promise<void> {
    const expiresAt = Date.now() + ttl;

    // Update in-memory cache
    this.setMemory(key, value, ttl);

    // Update database
    try {
      await this.supabase.from(this.tableName).upsert(
        {
          key,
          value: JSON.stringify(value),
          expires_at: new Date(expiresAt).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
    } catch (error) {
      console.error("Cache set error:", error);
      // Continue - in-memory cache still works
    }
  }

  /**
   * Delete value from cache.
   */
  async delete(key: string): Promise<void> {
    this.inMemoryCache.delete(key);
    await this.supabase.from(this.tableName).delete().eq("key", key);
  }

  /**
   * Clear all cache entries.
   */
  async clear(): Promise<void> {
    this.inMemoryCache.clear();
    await this.supabase.from(this.tableName).delete().neq("key", "");
  }

  /**
   * Set in-memory cache entry.
   */
  private setMemory(key: string, value: T, ttl: number): void {
    // Evict oldest entries if cache is full
    if (this.inMemoryCache.size >= this.maxMemorySize) {
      const firstKey = this.inMemoryCache.keys().next().value;
      if (firstKey) {
        this.inMemoryCache.delete(firstKey);
      }
    }

    this.inMemoryCache.set(key, {
      key,
      value,
      ttl,
      expiresAt: Date.now() + ttl,
    });
  }

  /**
   * Clean up expired entries from database.
   */
  async cleanup(): Promise<number> {
    try {
      const { data, error } = await this.supabase
        .from(this.tableName)
        .delete()
        .lt("expires_at", new Date().toISOString())
        .select();

      if (error) {
        console.error("Cache cleanup error:", error);
        return 0;
      }

      return data?.length || 0;
    } catch (error) {
      console.error("Cache cleanup error:", error);
      return 0;
    }
  }
}
