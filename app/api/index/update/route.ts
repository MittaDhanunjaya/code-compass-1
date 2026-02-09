import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkFile, hashContent } from "@/lib/indexing/chunker";
import { chunkFileEnhanced } from "@/lib/indexing/enhanced-chunker";
import type { IndexUpdateRequest } from "@/lib/indexing/types";
import { decrypt } from "@/lib/encrypt";
import { getProvider, type ProviderId } from "@/lib/llm/providers";
import { supportsEmbeddings } from "@/lib/llm/embeddings";
import { buildMerkleTree, getMerkleRoot, serializeMerkleTree, deserializeMerkleTree, findChangedFiles } from "@/lib/indexing/merkle";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: IndexUpdateRequest & { provider?: ProviderId; generateEmbeddings?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { workspaceId, filePaths, provider, generateEmbeddings } = body;
  if (!workspaceId || !Array.isArray(filePaths)) {
    return NextResponse.json(
      { error: "workspaceId and filePaths array are required" },
      { status: 400 }
    );
  }

  // Get provider for embeddings
  const providerId = provider ?? "openrouter";
  const shouldGenerateEmbeddings = generateEmbeddings !== false && supportsEmbeddings(providerId);
  
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
            console.warn("Failed to decrypt API key, skipping embeddings");
          }
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
    // Use Merkle tree to detect actual changes
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("merkle_tree_json, merkle_root")
      .eq("id", workspaceId)
      .single();

    let oldTree = workspace?.merkle_tree_json
      ? deserializeMerkleTree(JSON.stringify(workspace.merkle_tree_json))
      : null;

    // Get all current files for Merkle tree
    const { data: allFiles } = await supabase
      .from("workspace_files")
      .select("path, content")
      .eq("workspace_id", workspaceId);

    const allFilesList = (allFiles || []).map((f) => ({
      path: f.path,
      content: f.content ?? "",
    }));

    // Build new Merkle tree
    const newTree = buildMerkleTree(allFilesList);
    const newMerkleRoot = getMerkleRoot(newTree);

    // If Merkle root unchanged, skip indexing
    if (oldTree && workspace?.merkle_root === newMerkleRoot) {
      return NextResponse.json({
        success: true,
        updatedFiles: 0,
        totalChunks: 0,
        message: "No changes detected (Merkle root unchanged)",
        skipped: true,
      });
    }

    // Find actually changed files
    let filesToIndex = filePaths;
    if (oldTree) {
      const changedFiles = findChangedFiles(oldTree, allFilesList);
      filesToIndex = filePaths.filter((fp) => changedFiles.includes(fp));
    }

    let updatedFiles = 0;
    let totalChunks = 0;

    for (const filePath of filesToIndex) {
      // Get current file content
      const { data: file, error: fileError } = await supabase
        .from("workspace_files")
        .select("content")
        .eq("workspace_id", workspaceId)
        .eq("path", filePath)
        .single();

      if (fileError || !file) {
        // File doesn't exist - remove from index
        await supabase
          .from("code_chunks")
          .delete()
          .eq("workspace_id", workspaceId)
          .eq("file_path", filePath);
        await supabase
          .from("file_index_metadata")
          .delete()
          .eq("workspace_id", workspaceId)
          .eq("file_path", filePath);
        continue;
      }

      const content = file.content ?? "";
      const contentHash = hashContent(content);

      // Check if file needs re-indexing
      const { data: metadata } = await supabase
        .from("file_index_metadata")
        .select("content_hash")
        .eq("workspace_id", workspaceId)
        .eq("file_path", filePath)
        .single();

      if (metadata?.content_hash === contentHash) {
        // No changes, skip
        continue;
      }

      // Index supported file types
      const ext = filePath.split(".").pop()?.toLowerCase() || "";
      const supportedExts = ["ts", "tsx", "js", "jsx", "py", "go", "rs"];
      if (!supportedExts.includes(ext)) {
        continue;
      }

      // Remove old chunks
      await supabase
        .from("code_chunks")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("file_path", filePath);

      // Insert new chunks with embeddings using enhanced chunker
      const chunks = await chunkFileEnhanced(content, filePath);
      
      // Generate embeddings if enabled
      let embeddings: number[][] = [];
      if (shouldGenerateEmbeddings && apiKey && chunks.length > 0) {
        try {
          const provider = getProvider(providerId);
          const chunkTexts = chunks.map((c) => c.content);
          if (provider.embeddings) {
            embeddings = await provider.embeddings(chunkTexts, apiKey);
          }
        } catch (error) {
          console.error(`Failed to generate embeddings for ${filePath}:`, error);
        }
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i] ? `[${embeddings[i].join(",")}]` : null;
        
        await supabase.from("code_chunks").insert({
          workspace_id: workspaceId,
          file_path: filePath,
          chunk_index: i,
          content: chunk.content,
          symbols: chunk.symbols,
          embedding: embedding,
        });
        totalChunks++;
      }

      // Update metadata
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

    // Update Merkle tree
    await supabase
      .from("workspaces")
      .update({
        merkle_root: newMerkleRoot,
        merkle_tree_json: serializeMerkleTree(newTree),
      })
      .eq("id", workspaceId);

    return NextResponse.json({
      success: true,
      updatedFiles,
      totalChunks,
      message: `Updated index for ${updatedFiles} files`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Index update failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
