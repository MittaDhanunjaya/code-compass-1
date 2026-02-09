/**
 * Background indexing endpoint.
 * Returns immediately and processes indexing asynchronously.
 * Provides progress updates via WebSocket or polling.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkFileEnhanced } from "@/lib/indexing/enhanced-chunker";
import { hashContent } from "@/lib/indexing/chunker";
import { decrypt } from "@/lib/encrypt";
import { getProvider, type ProviderId } from "@/lib/llm/providers";
import { supportsEmbeddings } from "@/lib/llm/embeddings";
import { buildMerkleTree, getMerkleRoot, serializeMerkleTree } from "@/lib/indexing/merkle";
import { generateEmbeddingsParallel } from "@/lib/indexing/parallel-embeddings";
import { logError } from "@/lib/utils/error-handler";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    workspaceId?: string;
    provider?: ProviderId;
    generateEmbeddings?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const workspaceId = (body.workspaceId ?? "").trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspaceId is required" },
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

  // Start background indexing (don't await)
  indexWorkspaceBackground(supabase, workspaceId, user.id, body.provider ?? "openrouter", body.generateEmbeddings !== false)
    .catch((error) => {
      logError(
        "Background indexing failed",
        { category: "execution", severity: "high" },
        { workspaceId, error }
      );
    });

  // Return immediately
  return NextResponse.json({
    success: true,
    message: "Indexing started in background",
    workspaceId,
  });
}

/**
 * Background indexing worker.
 */
async function indexWorkspaceBackground(
  supabase: any,
  workspaceId: string,
  userId: string,
  providerId: ProviderId,
  shouldGenerateEmbeddings: boolean
): Promise<void> {
  // Update workspace status
  await supabase
    .from("workspaces")
    .update({
      indexing_status: "indexing",
      indexing_started_at: new Date().toISOString(),
    })
    .eq("id", workspaceId);

  try {
    // Get API key for embeddings
    let apiKey: string | null = null;
    if (shouldGenerateEmbeddings && supportsEmbeddings(providerId)) {
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
              // Will skip embeddings
            }
          }
        }
      }
    }

    // Get all files
    const { data: files, error: filesError } = await supabase
      .from("workspace_files")
      .select("path, content")
      .eq("workspace_id", workspaceId);

    if (filesError) {
      throw new Error(filesError.message);
    }

    // Clear existing index
    await supabase.from("code_chunks").delete().eq("workspace_id", workspaceId);
    await supabase
      .from("file_index_metadata")
      .delete()
      .eq("workspace_id", workspaceId);

    let totalChunks = 0;
    let indexedFiles = 0;
    const totalFiles = files?.length || 0;

    // Index files in batches
    const batchSize = 10;
    for (let i = 0; i < (files?.length || 0); i += batchSize) {
      const batch = files?.slice(i, i + batchSize) || [];

      // Process batch in parallel
      await Promise.all(
        batch.map(async (file: any) => {
          const path = file.path;
          const content = file.content ?? "";

          const ext = path.split(".").pop()?.toLowerCase() || "";
          const supportedExts = ["ts", "tsx", "js", "jsx", "py", "go", "rs"];
          if (!supportedExts.includes(ext)) {
            return;
          }

          const chunks = await chunkFileEnhanced(content, path);
          const contentHash = hashContent(content);

          // Generate embeddings in parallel
          let embeddings: number[][] = [];
          if (shouldGenerateEmbeddings && apiKey && chunks.length > 0) {
            try {
              const chunkTexts = chunks.map((c) => c.content);
              embeddings = await generateEmbeddingsParallel(
                chunkTexts,
                apiKey,
                providerId,
                { batchSize: 10, maxConcurrent: 3 }
              );
            } catch (error) {
              logError(
                `Failed to generate embeddings for ${path}`,
                { category: "api", severity: "medium" },
                { error, filePath: path }
              );
            }
          }

          // Insert chunks
          for (let j = 0; j < chunks.length; j++) {
            const chunk = chunks[j];
            const embedding = embeddings[j] ? `[${embeddings[j].join(",")}]` : null;

            await supabase.from("code_chunks").insert({
              workspace_id: workspaceId,
              file_path: path,
              chunk_index: j,
              content: chunk.content,
              symbols: chunk.symbols,
              embedding,
            });

            totalChunks++;
          }

          // Update metadata
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
        })
      );

      // Update progress
      await supabase
        .from("workspaces")
        .update({
          indexing_progress: Math.round((indexedFiles / totalFiles) * 100),
        })
        .eq("id", workspaceId);
    }

    // Update Merkle tree
    if (files && files.length > 0) {
      const merkleTree = buildMerkleTree(
        files.map((f: any) => ({ path: f.path, content: f.content ?? "" }))
      );
      const merkleRoot = getMerkleRoot(merkleTree);
      const merkleTreeJson = serializeMerkleTree(merkleTree);

      await supabase
        .from("workspaces")
        .update({
          merkle_root: merkleRoot,
          merkle_tree_json: merkleTreeJson,
          indexing_status: "completed",
          indexing_completed_at: new Date().toISOString(),
          indexing_progress: 100,
          indexing_file_count: indexedFiles,
        })
        .eq("id", workspaceId);
    }
  } catch (error) {
    await supabase
      .from("workspaces")
      .update({
        indexing_status: "failed",
        indexing_error: error instanceof Error ? error.message : String(error),
      })
      .eq("id", workspaceId);

    throw error;
  }
}
