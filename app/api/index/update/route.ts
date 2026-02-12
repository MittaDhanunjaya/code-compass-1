import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth, requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { updateIndex } from "@/services/vector.service";
import { indexUpdateBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";

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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const validation = validateBody(indexUpdateBodySchema, rawBody);
  if (!validation.success) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const body = validation.data;

  const { workspaceId, filePaths, provider, generateEmbeddings } = body;

  try {
    await requireWorkspaceAccess(request, workspaceId, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  try {
    const result = await updateIndex({
      supabase,
      userId: user.id,
      workspaceId,
      filePaths,
      provider,
      generateEmbeddings,
    });
    return NextResponse.json(result);
  } catch (e) {
    const { errorResponse } = await import("@/lib/errors");
    return errorResponse(e, { statusCode: 500 });
  }
}
