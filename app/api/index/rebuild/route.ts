import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ProviderId } from "@/lib/llm/providers";
import { rebuildIndex } from "@/services/vector.service";

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

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const result = await rebuildIndex({
      supabase,
      userId: user.id,
      workspaceId,
      provider: body.provider,
      generateEmbeddings: body.generateEmbeddings,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Index rebuild failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
