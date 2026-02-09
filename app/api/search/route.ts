import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SearchResult } from "@/lib/indexing/types";
import { decrypt } from "@/lib/encrypt";
import { getProvider, type ProviderId } from "@/lib/llm/providers";
import { supportsEmbeddings } from "@/lib/llm/embeddings";
import { searchCache, getSearchKey } from "@/lib/cache";
import { enhancedSemanticSearch } from "@/lib/indexing/semantic-search-enhanced";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query");
  const workspaceId = searchParams.get("workspaceId");
  const limit = parseInt(searchParams.get("limit") ?? "10", 10);
  const useSemantic = searchParams.get("semantic") !== "false"; // Default to true

  if (!query || !workspaceId) {
    return NextResponse.json(
      { error: "query and workspaceId are required" },
      { status: 400 }
    );
  }

  // Verify workspace access
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    // Check cache first
    const cacheKey = getSearchKey(workspaceId, query, limit, useSemantic);
    const cached = searchCache.get(cacheKey);
    if (cached) {
      return NextResponse.json({ ...cached, cached: true });
    }

    // Use enhanced semantic search if enabled (uses symbol graphs + vector search)
    if (useSemantic) {
      try {
        const enhancedResults = await enhancedSemanticSearch(
          supabase,
          workspaceId,
          query,
          user.id,
          limit
        );

        // Convert to SearchResult format
        const results: SearchResult[] = enhancedResults.map((r) => ({
          path: r.path,
          line: r.line,
          preview: r.preview,
        }));

        const response = { results, count: results.length };
        searchCache.set(cacheKey, response, 300000);
        return NextResponse.json(response);
      } catch (e) {
        const { logError } = await import("@/lib/utils/error-handler");
        logError(
          "Enhanced semantic search failed, falling back to basic search",
          { category: "api", severity: "medium" },
          { error: e, query, workspaceId }
        );
        // Fall through to basic search
      }
    }

    // Fallback to basic search
    let chunks: any[] = [];
    let useVectorSearch = false;

    // Try semantic search if enabled and embeddings are available
    if (useSemantic) {
      // Check if workspace has embeddings
      const { data: hasEmbeddings } = await supabase
        .from("code_chunks")
        .select("id")
        .eq("workspace_id", workspaceId)
        .not("embedding", "is", null)
        .limit(1);

      if (hasEmbeddings && hasEmbeddings.length > 0) {
        // Get API key for embedding generation
        const providerId: ProviderId = "openrouter";
        const { data: keyRow } = await supabase
          .from("provider_keys")
          .select("key_encrypted")
          .eq("user_id", user.id)
          .eq("provider", providerId)
          .single();

        let apiKey: string | null = null;
        if (keyRow?.key_encrypted) {
          try {
            apiKey = decrypt(keyRow.key_encrypted);
          } catch {
            // Fall back to OpenAI
            const { data: openAIKeyRow } = await supabase
              .from("provider_keys")
              .select("key_encrypted")
              .eq("user_id", user.id)
              .eq("provider", "openai")
              .single();
            if (openAIKeyRow?.key_encrypted) {
              try {
                apiKey = decrypt(openAIKeyRow.key_encrypted);
              } catch {
                // Will fall back to text search
              }
            }
          }
        }

        if (apiKey && supportsEmbeddings(providerId)) {
          try {
            // Generate embedding for query
            const provider = getProvider(providerId);
            if (provider.embeddings) {
              const queryEmbeddings = await provider.embeddings([query], apiKey);
              if (queryEmbeddings.length > 0 && queryEmbeddings[0].length > 0) {
                const queryVector = `[${queryEmbeddings[0].join(",")}]`;
                
                // Vector similarity search using cosine distance
                // pgvector: 1 - cosine_distance = similarity (higher is better)
                const { data: vectorResults, error: vectorError } = await supabase.rpc(
                  "match_code_chunks",
                  {
                    query_embedding: queryVector,
                    match_workspace_id: workspaceId,
                    match_threshold: 0.7, // Minimum similarity threshold
                    match_count: limit * 2,
                  }
                );

                if (!vectorError && vectorResults) {
                  chunks = vectorResults;
                  useVectorSearch = true;
                }
              }
            }
          } catch (error) {
            console.error("Vector search failed, falling back to text search:", error);
          }
        }
      }
    }

    // Fall back to text search if vector search didn't work
    if (!useVectorSearch) {
      const searchTerm = `%${query}%`;
      const { data: textChunks, error } = await supabase
        .from("code_chunks")
        .select("file_path, content, symbols, chunk_index, similarity")
        .eq("workspace_id", workspaceId)
        .ilike("content", searchTerm)
        .limit(limit * 2);

      if (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 500 }
        );
      }
      chunks = textChunks ?? [];
    }

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    // Deduplicate by file_path and create results
    const resultsMap = new Map<string, SearchResult>();
    const queryLower = query.toLowerCase();

    for (const chunk of chunks ?? []) {
      const path = chunk.file_path;
      const content = chunk.content ?? "";

      // Scoring: use similarity from vector search if available, otherwise count matches
      let score = chunk.similarity ?? 0;
      if (!useVectorSearch) {
        const matches = (content.toLowerCase().match(new RegExp(queryLower, "g")) ?? []).length;
        score = matches + (chunk.symbols?.some((s: any) =>
          s.name?.toLowerCase().includes(queryLower)
        ) ? 2 : 0);
      }

      // Find first matching line
      const lines = content.split("\n");
      let matchLine: number | undefined;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(queryLower)) {
          matchLine = i + 1;
          break;
        }
      }

      // Get preview (context around match)
      const previewStart = Math.max(0, (matchLine ?? 1) - 2);
      const previewEnd = Math.min(lines.length, previewStart + 5);
      const preview = lines.slice(previewStart, previewEnd).join("\n");

      const existing = resultsMap.get(path);
      if (!existing || (existing.score ?? 0) < score) {
        resultsMap.set(path, {
          path,
          line: matchLine,
          preview: preview.slice(0, 500), // Limit preview length
          score,
        });
      }
    }

    // Sort by score and limit
    const results: SearchResult[] = Array.from(resultsMap.values())
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
      .map((r) => ({ path: r.path, line: r.line, preview: r.preview })); // Remove score from response

    const response = { results, count: results.length };
    
    // Cache the results (5min TTL for search)
    searchCache.set(cacheKey, response, 300000);

    return NextResponse.json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Search failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
