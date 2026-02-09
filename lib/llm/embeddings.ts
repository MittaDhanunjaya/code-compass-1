/**
 * Embeddings generation utilities.
 * Uses OpenAI text-embedding-3-small (1536 dimensions) for semantic search.
 */

import OpenAI from "openai";
import type { ProviderId } from "./providers";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate embeddings using OpenAI API.
 * Falls back to OpenRouter if OpenAI key not available.
 */
export async function generateEmbeddings(
  texts: string[],
  apiKey: string,
  providerId: ProviderId
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // OpenAI and OpenRouter support embeddings
  if (providerId === "openai" || providerId === "openrouter") {
    try {
      const client = new OpenAI({
        apiKey,
        baseURL: providerId === "openrouter" ? "https://openrouter.ai/api/v1" : undefined,
        defaultHeaders:
          providerId === "openrouter"
            ? {
                "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "https://aiforge.app",
                "X-Title": "AIForge",
              }
            : undefined,
      });

      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      });

      return response.data.map((item) => item.embedding);
    } catch (error) {
      console.error(`Failed to generate embeddings with ${providerId}:`, error);
      return [];
    }
  }

  // Gemini and Perplexity don't have embeddings API in this setup
  // Return empty array - will fall back to text search
  return [];
}

/**
 * Check if provider supports embeddings.
 */
export function supportsEmbeddings(providerId: ProviderId): boolean {
  return providerId === "openai" || providerId === "openrouter";
}
