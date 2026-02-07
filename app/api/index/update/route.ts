import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkFile, hashContent } from "@/lib/indexing/chunker";
import type { IndexUpdateRequest } from "@/lib/indexing/types";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: IndexUpdateRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { workspaceId, filePaths } = body;
  if (!workspaceId || !Array.isArray(filePaths)) {
    return NextResponse.json(
      { error: "workspaceId and filePaths array are required" },
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
    let updatedFiles = 0;
    let totalChunks = 0;

    for (const filePath of filePaths) {
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

      // Only index TS/JS files
      if (
        !filePath.endsWith(".ts") &&
        !filePath.endsWith(".tsx") &&
        !filePath.endsWith(".js") &&
        !filePath.endsWith(".jsx")
      ) {
        continue;
      }

      // Remove old chunks
      await supabase
        .from("code_chunks")
        .delete()
        .eq("workspace_id", workspaceId)
        .eq("file_path", filePath);

      // Insert new chunks
      const chunks = chunkFile(content, filePath);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await supabase.from("code_chunks").insert({
          workspace_id: workspaceId,
          file_path: filePath,
          chunk_index: i,
          content: chunk.content,
          symbols: chunk.symbols,
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
