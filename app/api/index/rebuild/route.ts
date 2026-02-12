import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import type { ProviderId } from "@/lib/llm/providers";
import { rebuildIndex } from "@/services/vector.service";

export async function POST(request: Request) {
  let user: { id: string };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    const auth = await requireAuth(request);
    user = auth.user;
    supabase = auth.supabase;
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
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

  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
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
