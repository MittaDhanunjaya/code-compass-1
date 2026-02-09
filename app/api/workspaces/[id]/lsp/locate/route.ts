import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getDefinitionAndReferences } from "@/lib/lsp/typescript-language-service";

type RouteParams = { params: Promise<{ id: string }> };

const TS_JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const MAX_FILES_FOR_LSP = 200;

function isTsJs(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TS_JS_EXTENSIONS.has(ext);
}

/**
 * POST /api/workspaces/[id]/lsp/locate
 * Body: { path: string, line: number, character: number }
 * Returns same shape as symbols/locate: { symbol, definitions, references, currentFileOnly }
 * Uses in-process TypeScript language service for LSP-quality go-to-definition and find-references.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
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
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  let body: { path?: string; line?: number; character?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body; expected { path, line, character }" },
      { status: 400 }
    );
  }

  const filePath = body.path;
  const line = typeof body.line === "number" ? body.line : parseInt(String(body?.line ?? "1"), 10);
  const character =
    typeof body.character === "number"
      ? body.character
      : parseInt(String(body?.character ?? "1"), 10);

  if (!filePath || typeof filePath !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (!isTsJs(filePath)) {
    return NextResponse.json(
      { error: "LSP locate is only supported for TypeScript/JavaScript files" },
      { status: 400 }
    );
  }
  if (isNaN(line) || line < 1 || isNaN(character) || character < 1) {
    return NextResponse.json({ error: "line and character must be >= 1" }, { status: 400 });
  }

  const { data: files } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", id);

  const codeFiles = (files ?? []).filter((f) => {
    const p = f.path as string;
    return isTsJs(p) && !p.endsWith("/");
  }).slice(0, MAX_FILES_FOR_LSP);

  const fileMap = new Map<string, string>();
  for (const f of codeFiles) {
    const p = f.path as string;
    fileMap.set(p, (f.content as string) ?? "");
  }

  if (!fileMap.has(filePath)) {
    return NextResponse.json({
      symbol: null,
      definitions: [],
      references: [],
      currentFileOnly: true,
    });
  }

  try {
    const result = getDefinitionAndReferences(fileMap, filePath, line, character);
    if (!result) {
      return NextResponse.json({
        symbol: null,
        definitions: [],
        references: [],
        currentFileOnly: true,
      });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[LSP locate]", err);
    return NextResponse.json(
      { error: "LSP locate failed", details: String(err) },
      { status: 500 }
    );
  }
}
