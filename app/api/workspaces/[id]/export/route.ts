import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import JSZip from "jszip";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/workspaces/[id]/export
 * Export all workspace files as a downloadable ZIP archive.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify workspace access
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  // Fetch all workspace files
  const { data: files, error } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .order("path", { ascending: true });

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  if (!files || files.length === 0) {
    return NextResponse.json(
      { error: "Workspace is empty" },
      { status: 404 }
    );
  }

  // Create ZIP archive
  const zip = new JSZip();

  // Add all files to ZIP
  for (const file of files) {
    // Skip empty folders (paths ending with /)
    if (file.path.endsWith("/")) {
      continue;
    }
    zip.file(file.path, file.content || "");
  }

  // Generate ZIP buffer
  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // Create safe filename from workspace name
  const safeName = (workspace.name || "workspace")
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase()
    .substring(0, 50);

  // Return ZIP file as download
  return new NextResponse(new Uint8Array(zipBuffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}-${workspaceId.substring(0, 8)}.zip"`,
      "Content-Length": zipBuffer.length.toString(),
    },
  });
}
