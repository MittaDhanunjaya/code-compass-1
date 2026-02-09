/**
 * Parallel embedding generation with batching and rate limiting.
 * Improves indexing speed by processing multiple chunks concurrently.
 */

import type { ProviderId } from "@/lib/llm/providers";
import { getProvider } from "@/lib/llm/providers";

export type EmbeddingBatch = {
  texts: string[];
  embeddings: number[][];
  errors: Array<{ index: number; error: Error }>;
};

/**
 * Generate embeddings in parallel batches.
 * Respects API rate limits and processes efficiently.
 */
export async function generateEmbeddingsParallel(
  texts: string[],
  apiKey: string,
  providerId: ProviderId,
  options: {
    batchSize?: number; // Number of texts per batch
    maxConcurrent?: number; // Max concurrent batches
    delayBetweenBatches?: number; // Delay in ms between batches
  } = {}
): Promise<number[][]> {
  const {
    batchSize = 10, // Most APIs support 10-100 texts per request
    maxConcurrent = 3, // Process 3 batches concurrently
    delayBetweenBatches = 100, // 100ms delay to respect rate limits
  } = options;

  const provider = getProvider(providerId);
  if (!provider.embeddings) {
    throw new Error(`Provider ${providerId} does not support embeddings`);
  }

  // Split texts into batches
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const results: number[][] = [];
  const errors: Array<{ batch: number; error: Error }> = [];

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += maxConcurrent) {
    const concurrentBatches = batches.slice(i, i + maxConcurrent);

    const batchPromises = concurrentBatches.map(async (batch, batchIndex) => {
      try {
        const embeddings = await provider.embeddings(batch, apiKey);
        return { batchIndex: i + batchIndex, embeddings, error: null };
      } catch (error) {
        return {
          batchIndex: i + batchIndex,
          embeddings: null,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    // Collect results in order
    for (const result of batchResults) {
      if (result.error) {
        errors.push({ batch: result.batchIndex, error: result.error });
        // Fill with empty arrays for failed batches
        results.push(...new Array(batches[result.batchIndex].length).fill([]));
      } else {
        results.push(...result.embeddings);
      }
    }

    // Delay between batches to respect rate limits
    if (i + maxConcurrent < batches.length) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
    }
  }

  if (errors.length > 0) {
    console.warn(
      `Failed to generate embeddings for ${errors.length} batch(es) out of ${batches.length}`
    );
  }

  return results;
}

/**
 * Generate embeddings with retry logic for failed batches.
 */
export async function generateEmbeddingsWithRetry(
  texts: string[],
  apiKey: string,
  providerId: ProviderId,
  options: {
    batchSize?: number;
    maxRetries?: number;
    retryDelay?: number;
  } = {}
): Promise<number[][]> {
  const { maxRetries = 2, retryDelay = 1000, ...parallelOptions } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await generateEmbeddingsParallel(texts, apiKey, providerId, parallelOptions);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        // Exponential backoff
        const delay = retryDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Failed to generate embeddings after retries");
}
