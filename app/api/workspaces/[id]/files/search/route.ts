import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/workspaces/[id]/files/search?q=query
 * Text search across workspace files. Returns matches with path, line number, and snippet.
 */
export async function GET(
  request: Request,
  { params }: RouteParams
) {
  const { id: workspaceId } = await params;
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (!q) {
    return NextResponse.json([]);
  }

  const { data: files, error } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId)
    .not("path", "like", "%/");

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }

  const queryLower = q.toLowerCase();
  const results: { path: string; lineNumber: number; line: string }[] = [];

  for (const file of files ?? []) {
    const lines = (file.content ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        results.push({
          path: file.path,
          lineNumber: i + 1,
          line: lines[i].trim().slice(0, 120),
        });
      }
    }
  }

  return NextResponse.json(results);
}
