/**
 * Simple chunking and symbol extraction for TS/JS files (v1).
 * Uses regex-based parsing - good enough for v1.
 * Enhanced version available in enhanced-chunker.ts with multi-language support.
 */

export type SymbolInfo = {
  name: string;
  type: "function" | "class" | "export" | "variable";
  line: number;
  signature?: string;
};

export type CodeChunk = {
  content: string;
  startLine: number;
  endLine: number;
  symbols: SymbolInfo[];
};

const CHUNK_SIZE_LINES = 100; // Simple: chunk every 100 lines
const _MAX_CHUNK_SIZE = 5000; // Max characters per chunk

/**
 * Extract symbols (functions, classes, exports) from TS/JS code.
 */
export function extractSymbols(content: string, filePath: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const _lines = content.split("\n");
  const _isTS = filePath.endsWith(".ts") || filePath.endsWith(".tsx");

  // Match function declarations: function name(...) or const name = (...) =>
  const functionRegex = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(/gm;
  // Match class declarations: class Name
  const classRegex = /^(export\s+)?class\s+(\w+)/gm;
  // Match exports: export const/let/var name
  const exportRegex = /^export\s+(const|let|var|function|class|default)\s+(\w+)/gm;
  // Match arrow functions: const name = (...) =>
  const arrowFunctionRegex = /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(\([^)]*\)|[^=]+)\s*=>/gm;

  let match;
  while ((match = functionRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split("\n").length;
    symbols.push({
      name: match[3],
      type: "function",
      line,
      signature: match[0].trim(),
    });
  }

  while ((match = classRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split("\n").length;
    symbols.push({
      name: match[2],
      type: "class",
      line,
      signature: match[0].trim(),
    });
  }

  while ((match = exportRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split("\n").length;
    symbols.push({
      name: match[2],
      type: "export",
      line,
      signature: match[0].trim(),
    });
  }

  while ((match = arrowFunctionRegex.exec(content)) !== null) {
    const line = content.substring(0, match.index).split("\n").length;
    symbols.push({
      name: match[3],
      type: "function",
      line,
      signature: match[0].trim(),
    });
  }

  return symbols;
}

/**
 * Chunk file content into smaller pieces for indexing.
 * Simple approach: split by lines, respecting symbol boundaries when possible.
 */
export function chunkFile(
  content: string,
  filePath: string
): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const lines = content.split("\n");
  const symbols = extractSymbols(content, filePath);
  const symbolLines = new Set(symbols.map((s) => s.line));

  let currentChunk: string[] = [];
  let startLine = 1;
  let currentLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunk.push(line);
    currentLine = i + 1;

    // Chunk boundary conditions:
    // 1. Reached chunk size limit
    // 2. Hit a symbol boundary (prefer chunking at function/class boundaries)
    const shouldChunk =
      currentChunk.length >= CHUNK_SIZE_LINES ||
      (currentChunk.length >= 50 &&
        symbolLines.has(currentLine + 1) &&
        currentChunk.join("\n").length >= 1000);

    if (shouldChunk || i === lines.length - 1) {
      const chunkContent = currentChunk.join("\n");
      if (chunkContent.trim()) {
        // Find symbols in this chunk
        const chunkSymbols = symbols.filter(
          (s) => s.line >= startLine && s.line <= currentLine
        );

        chunks.push({
          content: chunkContent,
          startLine,
          endLine: currentLine,
          symbols: chunkSymbols,
        });
      }

      startLine = currentLine + 1;
      currentChunk = [];
    }
  }

  // If content is very small, ensure at least one chunk
  if (chunks.length === 0 && content.trim()) {
    chunks.push({
      content,
      startLine: 1,
      endLine: lines.length,
      symbols: extractSymbols(content, filePath),
    });
  }

  return chunks;
}

/**
 * Simple hash function for content (to detect changes).
 */
export function hashContent(content: string): string {
  // Simple hash - in production you'd use crypto.createHash
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}
