import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { updateIndex } from "@/services/vector.service";
import { indexUpdateBodySchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
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
