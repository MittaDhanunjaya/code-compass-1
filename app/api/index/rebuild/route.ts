import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkFile, hashContent } from "@/lib/indexing/chunker";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { workspaceId?: string };
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

      // Only index TS/JS files for v1
      if (
        !path.endsWith(".ts") &&
        !path.endsWith(".tsx") &&
        !path.endsWith(".js") &&
        !path.endsWith(".jsx")
      ) {
        continue;
      }

      const chunks = chunkFile(content, path);
      const contentHash = hashContent(content);

      // Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const { error: chunkError } = await supabase
          .from("code_chunks")
          .insert({
            workspace_id: workspaceId,
            file_path: path,
            chunk_index: i,
            content: chunk.content,
            symbols: chunk.symbols,
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
