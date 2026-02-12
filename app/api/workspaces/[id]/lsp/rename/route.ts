import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAccess, withAuthResponse } from "@/lib/auth/require-auth";
import { getRenameEdits } from "@/lib/lsp/typescript-language-service";

type RouteParams = { params: Promise<{ id: string }> };

const TS_JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
const MAX_FILES_FOR_LSP = 200;

function isTsJs(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TS_JS_EXTENSIONS.has(ext);
}

/**
 * POST /api/workspaces/[id]/lsp/rename
 * Body: { path: string, line: number, character: number, newName: string }
 * Returns { edits: { filePath, startLine, startColumn, endLine, endColumn, newText }[] }
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createClient();
  try {
    await requireWorkspaceAccess(request, id, supabase);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  let body: { path?: string; line?: number; character?: number; newName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body; expected { path, line, character, newName }" },
      { status: 400 }
    );
  }

  const filePath = body.path;
  const line = typeof body.line === "number" ? body.line : parseInt(String(body?.line ?? "1"), 10);
  const character =
    typeof body.character === "number"
      ? body.character
      : parseInt(String(body?.character ?? "1"), 10);
  const newName = typeof body.newName === "string" ? body.newName.trim() : "";

  if (!filePath || typeof filePath !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (!isTsJs(filePath)) {
    return NextResponse.json(
      { error: "Rename is only supported for TypeScript/JavaScript files" },
      { status: 400 }
    );
  }
  if (isNaN(line) || line < 1 || isNaN(character) || character < 1) {
    return NextResponse.json({ error: "line and character must be >= 1" }, { status: 400 });
  }
  if (newName === "") {
    return NextResponse.json({ error: "newName is required and must be non-empty" }, { status: 400 });
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
    return NextResponse.json({ edits: [] });
  }

  try {
    const edits = getRenameEdits(fileMap, filePath, line, character, newName);
    if (!edits || edits.length === 0) {
      return NextResponse.json({ edits: [] });
    }
    return NextResponse.json({ edits });
  } catch (err) {
    console.error("[LSP rename]", err);
    return NextResponse.json(
      { error: "Rename failed", details: String(err) },
      { status: 500 }
    );
  }
}
