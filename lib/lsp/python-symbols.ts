/**
 * Minimal Python symbol support for go-to-definition and find-references.
 * Uses regex-based def/class extraction (same as enhanced-chunker). No full AST.
 */

import { extractSymbolsEnhancedRegex } from "@/lib/indexing/enhanced-chunker";

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

export type PythonLocateResult = {
  symbol: string | null;
  definitions: { filePath: string; line: number }[];
  references: { filePath: string; line: number; context?: string }[];
  currentFileOnly: boolean;
};

/**
 * Get definition and references for a symbol at the given position in a Python file.
 * Used by LSP locate for .py files so F12 / Shift+F12 work.
 */
export function getDefinitionAndReferencesPython(
  content: string,
  filePath: string,
  line1Based: number,
  column1Based: number,
  allFiles?: { path: string; content: string }[]
): PythonLocateResult {
  const symbol = getWordAtPosition(content, line1Based, column1Based);
  if (!symbol) {
    return { symbol: null, definitions: [], references: [], currentFileOnly: true };
  }

  const definitions: { filePath: string; line: number }[] = [];
  const references: { filePath: string; line: number; context?: string }[] = [];
  const definitionLines = new Set<string>();

  const filesToSearch = allFiles && allFiles.length > 0
    ? allFiles.filter((f) => (f.path.split(".").pop()?.toLowerCase() ?? "") === "py")
    : [{ path: filePath, content }];

  const symbolRegex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");

  for (const { path: p, content: c } of filesToSearch) {
    const symbols = extractSymbolsEnhancedRegex(c, p);
    for (const s of symbols) {
      if (s.name === symbol) {
        definitions.push({ filePath: p, line: s.line });
        definitionLines.add(`${p}:${s.line}`);
      }
    }

    let match: RegExpExecArray | null;
    symbolRegex.lastIndex = 0;
    while ((match = symbolRegex.exec(c)) !== null) {
      const before = c.slice(0, match.index);
      const actualLine = 1 + (before.match(/\n/g)?.length ?? 0);
      if (definitionLines.has(`${p}:${actualLine}`)) continue;
      const lineStart = before.lastIndexOf("\n") + 1;
      const lineEnd = c.indexOf("\n", match.index);
      const end = lineEnd === -1 ? c.length : lineEnd;
      const context = c.slice(lineStart, end).trim().slice(0, 120);
      references.push({ filePath: p, line: actualLine, context });
    }
  }

  const currentFileOnly = filesToSearch.length <= 1;
  return {
    symbol,
    definitions,
    references,
    currentFileOnly,
  };
}
