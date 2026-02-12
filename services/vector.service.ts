/**
 * Phase 2.1.6: Vector/index service.
 * Extracts business logic from index and search routes.
 */

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/encrypt";
import { getProvider, type ProviderId } from "@/lib/llm/providers";
import { supportsEmbeddings } from "@/lib/llm/embeddings";
import { hashContent } from "@/lib/indexing/chunker";
import { chunkFileEnhanced } from "@/lib/indexing/enhanced-chunker";
import { buildMerkleTree, getMerkleRoot, serializeMerkleTree, deserializeMerkleTree, findChangedFiles } from "@/lib/indexing/merkle";
import { searchCache, getSearchKey } from "@/lib/cache";
import { enhancedSemanticSearch } from "@/lib/indexing/semantic-search-enhanced";
import type { SearchResult } from "@/lib/indexing/types";

export type SearchWorkspaceInput = {
  supabase: SupabaseClient;
  workspaceId: string;
  userId: string;
  query: string;
  limit?: number;
  useSemantic?: boolean;
};

export type SearchWorkspaceResult = {
  results: SearchResult[];
  count: number;
  cached?: boolean;
};

/**
 * Search workspace: cache, enhanced semantic, vector, or text fallback.
 */
export async function searchWorkspace(input: SearchWorkspaceInput): Promise<SearchWorkspaceResult> {
  const { supabase, workspaceId, userId, query, limit = 10, useSemantic = true } = input;

  const cacheKey = getSearchKey(workspaceId, query, limit, useSemantic);
  const cached = searchCache.get(cacheKey) as SearchWorkspaceResult | undefined;
  if (cached) {
    return { ...cached, cached: true };
  }

  if (useSemantic) {
    try {
      const enhancedResults = await enhancedSemanticSearch(supabase, workspaceId, query, userId, limit);
      const results: SearchResult[] = enhancedResults.map((r) => ({
        path: r.path,
        line: r.line,
        preview: r.preview,
      }));
      const response = { results, count: results.length };
      searchCache.set(cacheKey, response, 300000);
      return response;
    } catch (e) {
      const { logError, createStructuredError } = await import("@/lib/utils/error-handler");
      logError(createStructuredError("Enhanced semantic search failed, falling back to basic search", "api", "medium", { error: e, query, workspaceId }));
    }
  }

  let chunks: Array<{ file_path: string; content: string | null; symbols?: Array<{ name?: string }> | null; similarity?: number }> = [];
  let useVectorSearch = false;

  if (useSemantic) {
    const { data: hasEmbeddings } = await supabase
      .from("code_chunks")
      .select("id")
      .eq("workspace_id", workspaceId)
      .not("embedding", "is", null)
      .limit(1);

    if (hasEmbeddings && hasEmbeddings.length > 0) {
      const providerId: ProviderId = "openrouter";
      const { data: keyRow } = await supabase
        .from("provider_keys")
        .select("key_encrypted")
        .eq("user_id", userId)
        .eq("provider", providerId)
        .single();

      let apiKey: string | null = null;
      if (keyRow?.key_encrypted) {
        try {
          apiKey = decrypt(keyRow.key_encrypted);
        } catch {
          const { data: openAIKeyRow } = await supabase
            .from("provider_keys")
            .select("key_encrypted")
            .eq("user_id", userId)
            .eq("provider", "openai")
            .single();
          if (openAIKeyRow?.key_encrypted) {
            try {
              apiKey = decrypt(openAIKeyRow.key_encrypted);
            } catch {
              // Fall back to text search
            }
          }
        }
      }

      if (apiKey && supportsEmbeddings(providerId)) {
        try {
          const provider = getProvider(providerId);
          if (provider.embeddings) {
            const queryEmbeddings = await provider.embeddings([query], apiKey);
            if (queryEmbeddings.length > 0 && queryEmbeddings[0].length > 0) {
              const queryVector = `[${queryEmbeddings[0].join(",")}]`;
              const { data: vectorResults, error: vectorError } = await supabase.rpc("match_code_chunks", {
                query_embedding: queryVector,
                match_workspace_id: workspaceId,
                match_threshold: 0.7,
                match_count: limit * 2,
              });
              if (!vectorError && vectorResults) {
                chunks = vectorResults;
                useVectorSearch = true;
              }
            }
          }
        } catch {
          // Fall through
        }
      }
    }
  }

  if (!useVectorSearch) {
    const searchTerm = `%${query}%`;
    const { data: textChunks, error } = await supabase
      .from("code_chunks")
      .select("file_path, content, symbols, chunk_index, similarity")
      .eq("workspace_id", workspaceId)
      .ilike("content", searchTerm)
      .limit(limit * 2);
    if (error) throw new Error(error.message);
    chunks = textChunks ?? [];
  }

  const resultsMap = new Map<string, SearchResult & { score?: number }>();
  const queryLower = query.toLowerCase();

  for (const chunk of chunks ?? []) {
    const path = chunk.file_path;
    const content = chunk.content ?? "";
    let score = chunk.similarity ?? 0;
    if (!useVectorSearch) {
      const matches = (content.toLowerCase().match(new RegExp(queryLower, "g")) ?? []).length;
      score = matches + (chunk.symbols?.some((s) => s.name?.toLowerCase().includes(queryLower)) ? 2 : 0);
    }
    const lines = content.split("\n");
    let matchLine: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        matchLine = i + 1;
        break;
      }
    }
    const previewStart = Math.max(0, (matchLine ?? 1) - 2);
    const previewEnd = Math.min(lines.length, previewStart + 5);
    const preview = lines.slice(previewStart, previewEnd).join("\n");
    const existing = resultsMap.get(path);
    if (!existing || (existing.score ?? 0) < score) {
      resultsMap.set(path, { path, line: matchLine, preview: preview.slice(0, 500), score });
    }
  }

  const results: SearchResult[] = Array.from(resultsMap.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit)
    .map((r) => ({ path: r.path, line: r.line, preview: r.preview }));

  const response = { results, count: results.length };
  searchCache.set(cacheKey, response, 300000);
  return response;
}

/**
 * Resolve API key for embeddings (provider with OpenAI fallback).
 */
async function getEmbeddingApiKey(
  supabase: SupabaseClient,
  userId: string,
  providerId: ProviderId
): Promise<string | null> {
  const { data: keyRow } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", userId)
    .eq("provider", providerId)
    .single();

  if (keyRow?.key_encrypted) {
    try {
      return decrypt(keyRow.key_encrypted);
    } catch {
      // fallback
    }
  }
  const { data: openAIKeyRow } = await supabase
    .from("provider_keys")
    .select("key_encrypted")
    .eq("user_id", userId)
    .eq("provider", "openai")
    .single();
  if (openAIKeyRow?.key_encrypted) {
    try {
      return decrypt(openAIKeyRow.key_encrypted);
    } catch {
      // skip
    }
  }
  return null;
}

export type UpdateIndexInput = {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  filePaths: string[];
  provider?: ProviderId;
  generateEmbeddings?: boolean;
};

export type UpdateIndexResult = {
  success: boolean;
  updatedFiles: number;
  totalChunks: number;
  message: string;
  skipped?: boolean;
};

/**
 * Update index for changed files. Uses Merkle tree for change detection.
 */
export async function updateIndex(input: UpdateIndexInput): Promise<UpdateIndexResult> {
  const { supabase, userId, workspaceId, filePaths, provider = "openrouter", generateEmbeddings = true } = input;

  const providerId = provider as ProviderId;
  const shouldGenerateEmbeddings = generateEmbeddings !== false && supportsEmbeddings(providerId);
  const apiKey = shouldGenerateEmbeddings ? await getEmbeddingApiKey(supabase, userId, providerId) : null;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("merkle_tree_json, merkle_root")
    .eq("id", workspaceId)
    .single();

  const oldTree = workspace?.merkle_tree_json
    ? deserializeMerkleTree(JSON.stringify(workspace.merkle_tree_json))
    : null;

  const { data: allFiles } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  const allFilesList = (allFiles || []).map((f) => ({ path: f.path, content: f.content ?? "" }));
  const newTree = buildMerkleTree(allFilesList);
  const newMerkleRoot = getMerkleRoot(newTree);

  if (oldTree && workspace?.merkle_root === newMerkleRoot) {
    return {
      success: true,
      updatedFiles: 0,
      totalChunks: 0,
      message: "No changes detected (Merkle root unchanged)",
      skipped: true,
    };
  }

  let filesToIndex = filePaths;
  if (oldTree) {
    const changedFiles = findChangedFiles(oldTree, allFilesList);
    filesToIndex = filePaths.filter((fp) => changedFiles.includes(fp));
  }

  let updatedFiles = 0;
  let totalChunks = 0;

  for (const filePath of filesToIndex) {
    const { data: file, error: fileError } = await supabase
      .from("workspace_files")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("path", filePath)
      .single();

    if (fileError || !file) {
      await supabase.from("code_chunks").delete().eq("workspace_id", workspaceId).eq("file_path", filePath);
      await supabase.from("file_index_metadata").delete().eq("workspace_id", workspaceId).eq("file_path", filePath);
      continue;
    }

    const content = file.content ?? "";
    const contentHash = hashContent(content);

    const { data: metadata } = await supabase
      .from("file_index_metadata")
      .select("content_hash")
      .eq("workspace_id", workspaceId)
      .eq("file_path", filePath)
      .single();

    if (metadata?.content_hash === contentHash) continue;

    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const supportedExts = ["ts", "tsx", "js", "jsx", "py", "go", "rs"];
    if (!supportedExts.includes(ext)) continue;

    await supabase.from("code_chunks").delete().eq("workspace_id", workspaceId).eq("file_path", filePath);

    const chunks = await chunkFileEnhanced(content, filePath);
    const chunkHashes = chunks.map((c) => createHash("sha256").update(c.content).digest("hex"));

    let embeddings: number[][] = [];
    if (shouldGenerateEmbeddings && apiKey && chunks.length > 0) {
      try {
        const { data: cachedRows } = await supabase
          .from("embedding_cache")
          .select("content_hash, embedding")
          .in("content_hash", chunkHashes);

        const parseEmbedding = (v: unknown): number[] | null => {
          if (Array.isArray(v)) return v;
          if (typeof v === "string") {
            try {
              return JSON.parse(v) as number[];
            } catch {
              return null;
            }
          }
          return null;
        };
        const cacheMap = new Map(
          (cachedRows ?? [])
            .map((r) => {
              const emb = parseEmbedding(r.embedding);
              return emb ? [r.content_hash, emb] : null;
            })
            .filter((x): x is [string, number[]] => x != null)
        );

        const toEmbed: { index: number; text: string; hash: string }[] = [];
        const resultEmbeddings: (number[] | null)[] = new Array(chunks.length).fill(null);

        for (let i = 0; i < chunkHashes.length; i++) {
          const hash = chunkHashes[i];
          const cached = cacheMap.get(hash);
          if (cached && Array.isArray(cached)) {
            resultEmbeddings[i] = cached;
          } else {
            toEmbed.push({ index: i, text: chunks[i].content, hash });
          }
        }

        if (toEmbed.length > 0) {
          const provider = getProvider(providerId);
          if (provider.embeddings) {
            const texts = toEmbed.map((e) => e.text);
            const newEmbeddings = await provider.embeddings(texts, apiKey);
            const cacheRows: { content_hash: string; embedding: string }[] = [];
            for (let j = 0; j < toEmbed.length; j++) {
              const emb = newEmbeddings[j];
              if (emb) {
                resultEmbeddings[toEmbed[j].index] = emb;
                cacheRows.push({ content_hash: toEmbed[j].hash, embedding: `[${emb.join(",")}]` });
              }
            }
            if (cacheRows.length > 0) {
              await supabase.from("embedding_cache").upsert(cacheRows, { onConflict: "content_hash" });
            }
          }
        }
        embeddings = resultEmbeddings.map((e) => e ?? []);
      } catch (error) {
        console.error(`Failed to generate embeddings for ${filePath}:`, error);
      }
    }

    const rows = chunks.map((chunk, i) => ({
      workspace_id: workspaceId,
      file_path: filePath,
      chunk_index: i,
      content: chunk.content,
      symbols: chunk.symbols,
      embedding: embeddings[i]?.length ? `[${embeddings[i].join(",")}]` : null,
    }));

    if (rows.length > 0) {
      const { error: insertError } = await supabase.from("code_chunks").insert(rows);
      if (insertError) throw new Error(`Failed to insert chunks: ${insertError.message}`);
      totalChunks += rows.length;
    }

    await supabase.from("file_index_metadata").upsert(
      {
        workspace_id: workspaceId,
        file_path: filePath,
        content_hash: contentHash,
        indexed_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,file_path" }
    );

    updatedFiles++;
  }

  await supabase
    .from("workspaces")
    .update({
      merkle_root: newMerkleRoot,
      merkle_tree_json: serializeMerkleTree(newTree),
    })
    .eq("id", workspaceId);

  return {
    success: true,
    updatedFiles,
    totalChunks,
    message: `Updated index for ${updatedFiles} files`,
  };
}

export type RebuildIndexInput = {
  supabase: SupabaseClient;
  userId: string;
  workspaceId: string;
  provider?: ProviderId;
  generateEmbeddings?: boolean;
};

export type RebuildIndexResult = {
  success: boolean;
  indexedFiles: number;
  totalChunks: number;
  message: string;
};

/**
 * Full index rebuild. Clears and re-indexes all files.
 */
export async function rebuildIndex(input: RebuildIndexInput): Promise<RebuildIndexResult> {
  const { supabase, userId, workspaceId, provider = "openrouter", generateEmbeddings = true } = input;

  const providerId = provider as ProviderId;
  const shouldGenerateEmbeddings = generateEmbeddings !== false && supportsEmbeddings(providerId);
  const apiKey = shouldGenerateEmbeddings ? await getEmbeddingApiKey(supabase, userId, providerId) : null;

  const { data: files, error: filesError } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  if (filesError) throw new Error(filesError.message);

  await supabase.from("code_chunks").delete().eq("workspace_id", workspaceId);
  await supabase.from("file_index_metadata").delete().eq("workspace_id", workspaceId);

  let totalChunks = 0;
  let indexedFiles = 0;
  const supportedExts = ["ts", "tsx", "js", "jsx", "py", "go", "rs"];

  for (const file of files ?? []) {
    const path = file.path;
    const content = file.content ?? "";
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (!supportedExts.includes(ext)) continue;

    const chunks = await chunkFileEnhanced(content, path);
    const contentHash = hashContent(content);

    let embeddings: number[][] = [];
    if (shouldGenerateEmbeddings && apiKey && chunks.length > 0) {
      try {
        const { generateEmbeddingsParallel } = await import("@/lib/indexing/parallel-embeddings");
        const chunkTexts = chunks.map((c) => c.content);
        embeddings = await generateEmbeddingsParallel(chunkTexts, apiKey, providerId, {
          batchSize: 10,
          maxConcurrent: 3,
        });
      } catch (error) {
        const { logError, createStructuredError } = await import("@/lib/utils/error-handler");
        logError(createStructuredError(`Failed to generate embeddings for ${path}`, "api", "medium", { error, filePath: path }));
      }
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ? `[${embeddings[i].join(",")}]` : null;
      const { error: chunkError } = await supabase.from("code_chunks").insert({
        workspace_id: workspaceId,
        file_path: path,
        chunk_index: i,
        content: chunk.content,
        symbols: chunk.symbols,
        embedding,
      });
      if (!chunkError) totalChunks++;
    }

    await supabase.from("file_index_metadata").upsert(
      {
        workspace_id: workspaceId,
        file_path: path,
        content_hash: contentHash,
        indexed_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,file_path" }
    );

    indexedFiles++;
  }

  if (files && files.length > 0) {
    const merkleTree = buildMerkleTree(files.map((f) => ({ path: f.path, content: f.content ?? "" })));
    const merkleRoot = getMerkleRoot(merkleTree);
    const merkleTreeJson = serializeMerkleTree(merkleTree);
    await supabase
      .from("workspaces")
      .update({
        merkle_root: merkleRoot,
        merkle_tree_json: merkleTreeJson,
        indexing_status: "completed",
        indexing_progress: 100,
        indexing_file_count: indexedFiles,
      })
      .eq("id", workspaceId);
  }

  return {
    success: true,
    indexedFiles,
    totalChunks,
    message: `Indexed ${indexedFiles} files with ${totalChunks} chunks`,
  };
}
