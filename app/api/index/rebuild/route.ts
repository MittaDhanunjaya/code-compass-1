import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkFile, hashContent } from "@/lib/indexing/chunker";
import { chunkFileEnhanced } from "@/lib/indexing/enhanced-chunker";
import { decrypt } from "@/lib/encrypt";
import { getProvider, type ProviderId } from "@/lib/llm/providers";
import { supportsEmbeddings } from "@/lib/llm/embeddings";
import { buildMerkleTree, getMerkleRoot, serializeMerkleTree } from "@/lib/indexing/merkle";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { workspaceId?: string; provider?: ProviderId; generateEmbeddings?: boolean };
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

  // Get provider for embeddings (default to openrouter if available)
  const providerId = body.provider ?? "openrouter";
  const shouldGenerateEmbeddings = body.generateEmbeddings !== false && supportsEmbeddings(providerId);
  
  let apiKey: string | null = null;
  if (shouldGenerateEmbeddings) {
    const { data: keyRow } = await supabase
      .from("provider_keys")
      .select("key_encrypted")
      .eq("user_id", user.id)
      .eq("provider", providerId)
      .single();
    
    if (keyRow?.key_encrypted) {
      try {
        apiKey = decrypt(keyRow.key_encrypted);
      } catch {
        console.warn(`Failed to decrypt ${providerId} key, skipping embeddings`);
      }
    }
    
    if (!apiKey) {
      // Try OpenAI as fallback
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
          console.warn("Failed to decrypt OpenAI key, skipping embeddings");
        }
      }
    }
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
    // Get all files in workspace
    const { data: files, error: filesError } = await supabase
      .from("workspace_files")
      .select("path, content")
      .eq("workspace_id", workspaceId);

    if (filesError) {
      return NextResponse.json(
        { error: filesError.message },
        { status: 500 }
      );
    }

    // Clear existing index for this workspace
    await supabase.from("code_chunks").delete().eq("workspace_id", workspaceId);
    await supabase
      .from("file_index_metadata")
      .delete()
      .eq("workspace_id", workspaceId);

    let totalChunks = 0;
    let indexedFiles = 0;

    // Index each file
    for (const file of files ?? []) {
      const path = file.path;
      const content = file.content ?? "";

      // Index supported file types
      const ext = path.split(".").pop()?.toLowerCase() || "";
      const supportedExts = ["ts", "tsx", "js", "jsx", "py", "go", "rs"];
      if (!supportedExts.includes(ext)) {
        continue;
      }

      // Use enhanced chunker for better symbol extraction (AST parser when available)
      const chunks = await chunkFileEnhanced(content, path);
      const contentHash = hashContent(content);

      // Generate embeddings if enabled and API key available (parallel processing)
      let embeddings: number[][] = [];
      if (shouldGenerateEmbeddings && apiKey && chunks.length > 0) {
        try {
          const { generateEmbeddingsParallel } = await import("@/lib/indexing/parallel-embeddings");
          const chunkTexts = chunks.map((c) => c.content);
          embeddings = await generateEmbeddingsParallel(
            chunkTexts,
            apiKey,
            providerId,
            { batchSize: 10, maxConcurrent: 3 }
          );
        } catch (error) {
          const { logError } = await import("@/lib/utils/error-handler");
          logError(
            `Failed to generate embeddings for ${path}`,
            { category: "api", severity: "medium" },
            { error, filePath: path }
          );
        }
      }

      // Insert chunks with embeddings
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i] ? `[${embeddings[i].join(",")}]` : null;
        
        const { error: chunkError } = await supabase
          .from("code_chunks")
          .insert({
            workspace_id: workspaceId,
            file_path: path,
            chunk_index: i,
            content: chunk.content,
            symbols: chunk.symbols,
            embedding: embedding, // pgvector format: [1,2,3,...]
          });

        if (chunkError) {
          console.error(`Failed to index chunk ${i} of ${path}:`, chunkError);
        } else {
          totalChunks++;
        }
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
    }

    // Update Merkle tree for efficient change detection
    if (files && files.length > 0) {
      const merkleTree = buildMerkleTree(
        files.map((f) => ({ path: f.path, content: f.content ?? "" }))
      );
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

    return NextResponse.json({
      success: true,
      indexedFiles,
      totalChunks,
      message: `Indexed ${indexedFiles} files with ${totalChunks} chunks`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Index rebuild failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
