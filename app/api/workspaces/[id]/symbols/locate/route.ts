import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findSymbolReferences } from "@/lib/indexing/symbol-graph";
import { extractSymbolsEnhancedRegex } from "@/lib/indexing/enhanced-chunker";
import type { SupabaseClient } from "@supabase/supabase-js";

type RouteParams = { params: Promise<{ id: string }> };

const MAX_FALLBACK_LINES = 3000;
/** Max files to scan for on-demand cross-file symbol search (no index). */
const CROSS_FILE_SEARCH_MAX_FILES = 80;
/** Time budget (ms) for cross-file search so F12 stays responsive. */
const CROSS_FILE_TIME_BUDGET_MS = 2000;
/** Cache TTL (ms) for symbol locate results. */
const SYMBOL_LOCATE_CACHE_TTL_MS = 30_000;
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "kt"]);
const TS_JS_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);

const symbolLocateCache = new Map<string, { result: unknown; ts: number }>();

function getWordAtPosition(content: string, line1Based: number, column1Based: number): string | null {
  const lines = content.split("\n");
  const lineIndex = line1Based - 1;
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  const line = lines[lineIndex];
  const colIndex = column1Based - 1;
  if (colIndex < 0 || colIndex > line.length) return null;
  const before = line.slice(0, colIndex).match(/\w+$/);
  const after = line.slice(colIndex).match(/^\w*/);
  const word = (before ? before[0] : "") + (after ? after[0] : "");
  return word.length > 0 ? word : null;
}

/**
 * Current-file-only fallback when code_chunks are empty (workspace not indexed).
 * Returns definitions and references within the same file using in-process symbol extraction + word scan.
 */
function currentFileFallback(
  content: string,
  filePath: string,
  symbolName: string,
  lineNum: number
): { definitions: { filePath: string; line: number }[]; references: { filePath: string; line: number; context?: string }[] } {
  const lines = content.split("\n");
  const limitedLines = lines.length > MAX_FALLBACK_LINES ? lines.slice(0, MAX_FALLBACK_LINES) : lines;
  const limitedContent = limitedLines.join("\n");

  const definitions: { filePath: string; line: number }[] = [];
  const references: { filePath: string; line: number; context?: string }[] = [];
  const definitionLines = new Set<number>();

  try {
    const symbols = extractSymbolsEnhancedRegex(limitedContent, filePath);
    const matching = symbols.filter((s) => s.name === symbolName);
    for (const s of matching) {
      definitions.push({ filePath, line: s.line });
      definitionLines.add(s.line);
    }
  } catch {
    // Unsupported language or parse error; we'll still add references via word scan
  }

  const symbolRegex = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  let match: RegExpExecArray | null;
  symbolRegex.lastIndex = 0;
  while ((match = symbolRegex.exec(limitedContent)) !== null) {
    const before = limitedContent.slice(0, match.index);
    const actualLine = 1 + (before.match(/\n/g)?.length ?? 0);
    if (definitionLines.has(actualLine)) continue;
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = limitedContent.indexOf("\n", match.index);
    const end = lineEnd === -1 ? limitedContent.length : lineEnd;
    const context = limitedContent.slice(lineStart, end).trim().slice(0, 120);
    references.push({ filePath, line: actualLine, context });
  }

  return { definitions, references };
}

/**
 * On-demand cross-file symbol search when workspace is not indexed.
 * Scans workspace_files for symbol definitions and references (grep + extractSymbols).
 */
async function crossFileSymbolSearch(
  supabase: SupabaseClient,
  workspaceId: string,
  symbolName: string,
  currentFilePath: string
): Promise<{ definitions: { filePath: string; line: number }[]; references: { filePath: string; line: number; context?: string }[] }> {
  const startTime = Date.now();
  const { data: files } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  const allCode = (files ?? []).filter((f) => {
    const ext = (f.path as string).split(".").pop()?.toLowerCase() ?? "";
    return CODE_EXTENSIONS.has(ext) && !(f.path as string).endsWith("/");
  });
  const tsJsFirst = allCode.filter((f) => TS_JS_EXTENSIONS.has((f.path as string).split(".").pop()?.toLowerCase() ?? ""));
  const rest = allCode.filter((f) => !TS_JS_EXTENSIONS.has((f.path as string).split(".").pop()?.toLowerCase() ?? ""));
  const codeFiles = [...tsJsFirst, ...rest].slice(0, CROSS_FILE_SEARCH_MAX_FILES);

  const definitions: { filePath: string; line: number }[] = [];
  const references: { filePath: string; line: number; context?: string }[] = [];
  const definitionKeys = new Set<string>();

  const symbolRegex = new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");

  for (const file of codeFiles) {
    if (Date.now() - startTime > CROSS_FILE_TIME_BUDGET_MS) break;
    const content = (file.content as string) ?? "";
    const path = file.path as string;
    const lines = content.split("\n");
    const limitedLines = lines.length > MAX_FALLBACK_LINES ? lines.slice(0, MAX_FALLBACK_LINES) : lines;
    const limitedContent = limitedLines.join("\n");

    try {
      const symbols = extractSymbolsEnhancedRegex(limitedContent, path);
      for (const s of symbols) {
        if (s.name === symbolName) {
          definitions.push({ filePath: path, line: s.line });
          definitionKeys.add(`${path}:${s.line}`);
        }
      }
    } catch {
      // skip
    }

    let match: RegExpExecArray | null;
    symbolRegex.lastIndex = 0;
    while ((match = symbolRegex.exec(limitedContent)) !== null) {
      const before = limitedContent.slice(0, match.index);
      const actualLine = 1 + (before.match(/\n/g)?.length ?? 0);
      if (definitionKeys.has(`${path}:${actualLine}`)) continue;
      const lineStart = before.lastIndexOf("\n") + 1;
      const lineEnd = limitedContent.indexOf("\n", match.index);
      const end = lineEnd === -1 ? limitedContent.length : lineEnd;
      const context = limitedContent.slice(lineStart, end).trim().slice(0, 120);
      references.push({ filePath: path, line: actualLine, context });
    }
  }

  const sameFileFirst = (a: { filePath: string }, b: { filePath: string }) =>
    (a.filePath === currentFilePath ? 0 : 1) - (b.filePath === currentFilePath ? 0 : 1);
  definitions.sort(sameFileFirst);
  references.sort((a, b) => (a.filePath !== b.filePath ? sameFileFirst(a, b) : a.line - b.line));
  return { definitions, references };
}

export async function GET(request: Request, { params }: RouteParams) {
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

  const url = new URL(request.url);
  const filePath = url.searchParams.get("filePath");
  const line = url.searchParams.get("line");
  const character = url.searchParams.get("character");

  if (!filePath || !line) {
    return NextResponse.json(
      { error: "filePath and line are required" },
      { status: 400 }
    );
  }

  const lineNum = parseInt(line, 10);
  const charNum = parseInt(character ?? "1", 10);
  if (isNaN(lineNum) || lineNum < 1) {
    return NextResponse.json({ error: "Invalid line" }, { status: 400 });
  }

  const { data: file } = await supabase
    .from("workspace_files")
    .select("content")
    .eq("workspace_id", id)
    .eq("path", filePath)
    .single();

  const content = (file?.content as string) ?? "";
  const symbolName = getWordAtPosition(content, lineNum, charNum);
  if (!symbolName) {
    return NextResponse.json({
      symbol: null,
      definitions: [],
      references: [],
      currentFileOnly: false,
    });
  }

  const cacheKey = `${id}:${symbolName}`;
  const cached = symbolLocateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SYMBOL_LOCATE_CACHE_TTL_MS) {
    return NextResponse.json(cached.result);
  }

  const refs = await findSymbolReferences(supabase, id, symbolName);
  const hasIndexResults = refs.length > 0;

  if (hasIndexResults) {
    const definitions = refs.map((r) => ({ filePath: r.filePath, line: r.line }));
    const references: { filePath: string; line: number; context?: string }[] = [];
    for (const r of refs) {
      for (const ref of r.references) {
        references.push({
          filePath: ref.filePath,
          line: ref.line,
          context: ref.context,
        });
      }
    }
    const result = { symbol: symbolName, definitions, references, currentFileOnly: false };
    symbolLocateCache.set(cacheKey, { result, ts: Date.now() });
    return NextResponse.json(result);
  }

  const { definitions: defFallback, references: refFallback } = currentFileFallback(
    content,
    filePath,
    symbolName,
    lineNum
  );

  // On-demand cross-file search (no index): scan workspace_files for symbol
  const crossFile = await crossFileSymbolSearch(supabase, id, symbolName, filePath);
  const defKeys = new Set(defFallback.map((d) => `${d.filePath}:${d.line}`));
  const refKeys = new Set(refFallback.map((r) => `${r.filePath}:${r.line}:${r.context ?? ""}`));
  for (const d of crossFile.definitions) {
    if (!defKeys.has(`${d.filePath}:${d.line}`)) {
      defFallback.push(d);
      defKeys.add(`${d.filePath}:${d.line}`);
    }
  }
  for (const r of crossFile.references) {
    const key = `${r.filePath}:${r.line}:${r.context ?? ""}`;
    if (!refKeys.has(key)) {
      refFallback.push(r);
      refKeys.add(key);
    }
  }

  const result = {
    symbol: symbolName,
    definitions: defFallback,
    references: refFallback,
    currentFileOnly: crossFile.definitions.length === 0 && crossFile.references.length === 0,
  };
  symbolLocateCache.set(cacheKey, { result, ts: Date.now() });
  return NextResponse.json(result);
}
