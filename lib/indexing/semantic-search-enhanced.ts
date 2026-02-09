/**
 * Enhanced semantic search that uses symbol graphs and codebase understanding.
 * Goes beyond simple vector similarity to understand code relationships.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildFileDependencyGraph, findSymbolReferences } from "./symbol-graph";
import { getProvider, type ProviderId } from "@/lib/llm/providers";
import { supportsEmbeddings, generateEmbeddings } from "@/lib/llm/embeddings";
import { decrypt } from "@/lib/encrypt";

export type EnhancedSearchResult = {
  path: string;
  line?: number;
  preview: string;
  relevanceScore: number;
  reason: string; // Why this result is relevant
  relatedSymbols?: string[]; // Symbols mentioned in this file
  dependencies?: string[]; // Files this depends on or is depended by
};

/**
 * Enhanced semantic search that considers:
 * 1. Vector similarity (semantic meaning)
 * 2. Symbol references (code relationships)
 * 3. Dependency graphs (file relationships)
 * 4. Code structure (imports, exports, patterns)
 */
export async function enhancedSemanticSearch(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  userId: string,
  limit: number = 10
): Promise<EnhancedSearchResult[]> {
  const results: EnhancedSearchResult[] = [];
  
  // Step 1: Get API key for embeddings
  let apiKey: string | null = null;
  let providerId: ProviderId = "openrouter";
  
  const { data: keyRow } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", userId)
    .eq("provider", providerId)
    .maybeSingle();
  
  if (keyRow?.key_encrypted) {
    try {
      apiKey = decrypt(keyRow.key_encrypted);
    } catch {
      // Try OpenAI as fallback
      const { data: openAIKeyRow } = await supabase
        .from("provider_keys")
        .select("key_encrypted")
        .eq("user_id", userId)
        .eq("provider", "openai")
        .maybeSingle();
      if (openAIKeyRow?.key_encrypted) {
        try {
          apiKey = decrypt(openAIKeyRow.key_encrypted);
          providerId = "openai";
        } catch {
          // Will use text search only
        }
      }
    }
  }

  // Step 2: Vector similarity search (if embeddings available)
  let vectorResults: any[] = [];
  if (apiKey && supportsEmbeddings(providerId)) {
    try {
      const queryEmbeddings = await generateEmbeddings([query], apiKey, providerId);
      if (queryEmbeddings.length > 0 && queryEmbeddings[0].length > 0) {
        const queryVector = `[${queryEmbeddings[0].join(",")}]`;
        
        const { data: vectorChunks } = await supabase.rpc("match_code_chunks", {
          query_embedding: queryVector,
          match_workspace_id: workspaceId,
          match_threshold: 0.6, // Lower threshold for broader results
          match_count: limit * 3,
        });
        
        vectorResults = vectorChunks || [];
      }
    } catch (e) {
      console.error("Vector search failed:", e);
    }
  }

  // Step 3: Extract symbols from query (if it mentions function/class names)
  const symbolMatches = query.match(/\b([A-Z][a-zA-Z0-9]+|\w+)\b/g) || [];
  const potentialSymbols = symbolMatches.filter(s => s.length > 3).slice(0, 3);

  // Step 4: Build dependency graph for relationship scoring
  const dependencyGraph = await buildFileDependencyGraph(supabase, workspaceId);

  // Step 5: Find symbol references if query mentions symbols
  const symbolReferencesMap = new Map<string, any[]>();
  for (const symbol of potentialSymbols) {
    const refs = await findSymbolReferences(supabase, workspaceId, symbol);
    if (refs.length > 0) {
      symbolReferencesMap.set(symbol, refs);
    }
  }

  // Step 6: Combine and score results
  const resultsMap = new Map<string, EnhancedSearchResult>();

  // Add vector search results
  for (const chunk of vectorResults) {
    const path = chunk.file_path;
    const existing = resultsMap.get(path);
    const score = (chunk.similarity || 0) * 0.6; // Base semantic similarity
    
    if (!existing || existing.relevanceScore < score) {
      const lines = (chunk.content || "").split("\n");
      const previewStart = Math.max(0, (chunk.chunk_index || 0) * 100 - 2);
      const previewEnd = Math.min(lines.length, previewStart + 5);
      const preview = lines.slice(previewStart, previewEnd).join("\n");

      resultsMap.set(path, {
        path,
        line: chunk.chunk_index ? chunk.chunk_index * 100 : undefined,
        preview: preview.slice(0, 500),
        relevanceScore: score,
        reason: "Semantic similarity to query",
        relatedSymbols: (chunk.symbols || []).map((s: any) => s.name).slice(0, 5),
      });
    }
  }

  // Boost scores for files with symbol references
  for (const [symbol, refs] of symbolReferencesMap.entries()) {
    for (const ref of refs) {
      const existing = resultsMap.get(ref.filePath);
      if (existing) {
        existing.relevanceScore += 0.3; // Boost for symbol match
        existing.reason = `Contains symbol '${symbol}'`;
        if (!existing.relatedSymbols) existing.relatedSymbols = [];
        if (!existing.relatedSymbols.includes(symbol)) {
          existing.relatedSymbols.push(symbol);
        }
      } else {
        // Add new result for symbol reference
        const { data: file } = await supabase
          .from("workspace_files")
          .select("content")
          .eq("workspace_id", workspaceId)
          .eq("path", ref.filePath)
          .single();
        
        if (file?.content) {
          const lines = file.content.split("\n");
          const previewStart = Math.max(0, ref.line - 2);
          const previewEnd = Math.min(lines.length, previewStart + 5);
          const preview = lines.slice(previewStart, previewEnd).join("\n");

          resultsMap.set(ref.filePath, {
            path: ref.filePath,
            line: ref.line,
            preview: preview.slice(0, 500),
            relevanceScore: 0.3,
            reason: `References symbol '${symbol}'`,
            relatedSymbols: [symbol],
          });
        }
      }
    }
  }

  // Boost scores for files with dependency relationships
  for (const [path, result] of resultsMap.entries()) {
    const deps = dependencyGraph.get(path);
    if (deps) {
      // If file is imported by many files, it's likely important
      if (deps.dependedBy.length > 0) {
        result.relevanceScore += 0.1 * Math.min(deps.dependedBy.length, 5);
        if (!result.dependencies) result.dependencies = [];
        result.dependencies.push(...deps.dependedBy.slice(0, 3));
      }
    }
  }

  // Step 7: Fallback to text search if no results
  if (resultsMap.size === 0) {
    const { data: textChunks } = await supabase
      .from("code_chunks")
      .select("file_path, content, chunk_index")
      .eq("workspace_id", workspaceId)
      .ilike("content", `%${query}%`)
      .limit(limit * 2);

    if (textChunks) {
      for (const chunk of textChunks) {
        const path = chunk.file_path;
        if (!resultsMap.has(path)) {
          const lines = (chunk.content || "").split("\n");
          const preview = lines.slice(0, 5).join("\n");

          resultsMap.set(path, {
            path,
            preview: preview.slice(0, 500),
            relevanceScore: 0.2,
            reason: "Text match",
          });
        }
      }
    }
  }

  // Sort by relevance score and return top results
  return Array.from(resultsMap.values())
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
}
