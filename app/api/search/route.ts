import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SearchResult } from "@/lib/indexing/types";

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
    // Simple text search using PostgreSQL full-text search
    // For v1, we'll use ILIKE for simplicity (can upgrade to tsvector later)
    const searchTerm = `%${query}%`;

    const { data: chunks, error } = await supabase
      .from("code_chunks")
      .select("file_path, content, symbols, chunk_index")
      .eq("workspace_id", workspaceId)
      .ilike("content", searchTerm)
      .limit(limit * 2); // Get more, then dedupe and rank

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

      // Simple scoring: count matches
      const matches = (content.toLowerCase().match(new RegExp(queryLower, "g")) ?? []).length;
      const score = matches + (chunk.symbols?.some((s: any) =>
        s.name?.toLowerCase().includes(queryLower)
      ) ? 2 : 0);

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

    return NextResponse.json({ results, count: results.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Search failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
