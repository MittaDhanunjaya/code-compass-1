import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchWorkspace } from "@/services/vector.service";

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
  const useSemantic = searchParams.get("semantic") !== "false";

  if (!query || !workspaceId) {
    return NextResponse.json(
      { error: "query and workspaceId are required" },
      { status: 400 }
    );
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const result = await searchWorkspace({
      supabase,
      workspaceId,
      userId: user.id,
      query,
      limit,
      useSemantic,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Search failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
