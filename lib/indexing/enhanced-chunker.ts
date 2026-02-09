/**
 * Enhanced code chunking with better symbol extraction.
 * Uses AST parsing (Tree-sitter) when available, falls back to improved regex patterns.
 */

import type { SymbolInfo, CodeChunk } from "./chunker";
import { extractSymbolsAST } from "./ast-parser";

const CHUNK_SIZE_LINES = 100;
const MAX_CHUNK_SIZE = 5000;
const MIN_CHUNK_SIZE = 50; // Minimum lines before chunking at symbol boundary

/**
 * Enhanced symbol extraction with AST parsing (when available) or improved regex patterns.
 * Supports TypeScript, JavaScript, Python, Go, Rust patterns.
 */
export async function extractSymbolsEnhanced(content: string, filePath: string): Promise<SymbolInfo[]> {
  // Try AST parsing first (Tree-sitter), fall back to regex
  try {
    const astSymbols = await extractSymbolsAST(content, filePath);
    if (astSymbols.length > 0) {
      return astSymbols;
    }
  } catch (error) {
    // Fall through to regex
  }

  // Fallback to regex-based extraction
  return extractSymbolsEnhancedRegex(content, filePath);
}

/**
 * Regex-based symbol extraction (fallback when AST parsing unavailable).
 * Exported so ast-parser can use it directly to avoid circular dependency.
 */
export function extractSymbolsEnhancedRegex(content: string, filePath: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const lines = content.split("\n");
  
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isTS = ext === "ts" || ext === "tsx";
  const isJS = ext === "js" || ext === "jsx";
  const isPython = ext === "py";
  const isGo = ext === "go";
  const isRust = ext === "rs";

  // TypeScript/JavaScript patterns
  if (isTS || isJS) {
    // Function declarations: function name(...) or async function name(...)
    const functionRegex = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(/gm;
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

    // Class declarations: class Name { or export class Name
    const classRegex = /^(export\s+)?(abstract\s+)?class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[3],
        type: "class",
        line,
        signature: match[0].trim(),
      });
    }

    // Arrow functions: const name = (...) => or const name = async (...) =>
    const arrowFunctionRegex = /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*=>/gm;
    while ((match = arrowFunctionRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[3],
        type: "function",
        line,
        signature: match[0].trim(),
      });
    }

    // Method definitions: name(...) { or name: (...) => {
    const methodRegex = /^\s*(public\s+|private\s+|protected\s+)?(\w+)\s*[(:]/gm;
    while ((match = methodRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      const prevLine = lines[line - 2]?.trim() || "";
      // Only if it looks like a method (not a function call)
      if (prevLine.includes("class") || prevLine.includes("interface") || prevLine.endsWith("{")) {
        symbols.push({
          name: match[2],
          type: "function",
          line,
          signature: match[0].trim(),
        });
      }
    }

    // Exports: export const/let/var/function/class name
    const exportRegex = /^export\s+(const|let|var|function|class|default|interface|type|enum)\s+(\w+)/gm;
    while ((match = exportRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[2],
        type: "export",
        line,
        signature: match[0].trim(),
      });
    }

    // Interfaces and types: interface Name or type Name
    const interfaceRegex = /^(export\s+)?(interface|type)\s+(\w+)/gm;
    while ((match = interfaceRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[3],
        type: "export",
        line,
        signature: match[0].trim(),
      });
    }
  }

  // Python patterns
  if (isPython) {
    // Function definitions: def name(...):
    const defRegex = /^def\s+(\w+)\s*\(/gm;
    let match;
    while ((match = defRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[1],
        type: "function",
        line,
        signature: match[0].trim(),
      });
    }

    // Class definitions: class Name:
    const classRegex = /^class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[1],
        type: "class",
        line,
        signature: match[0].trim(),
      });
    }
  }

  // Go patterns
  if (isGo) {
    // Function definitions: func name(...) or func (r *Receiver) name(...)
    const funcRegex = /^func\s+(\([^)]+\)\s+)?(\w+)\s*\(/gm;
    let match;
    while ((match = funcRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[2],
        type: "function",
        line,
        signature: match[0].trim(),
      });
    }

    // Type definitions: type Name struct or type Name interface
    const typeRegex = /^type\s+(\w+)\s+(struct|interface)/gm;
    while ((match = typeRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[1],
        type: "class",
        line,
        signature: match[0].trim(),
      });
    }
  }

  // Rust patterns
  if (isRust) {
    // Function definitions: fn name(...) or pub fn name(...)
    const fnRegex = /^(pub\s+)?fn\s+(\w+)\s*\(/gm;
    let match;
    while ((match = fnRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[2],
        type: "function",
        line,
        signature: match[0].trim(),
      });
    }

    // Struct definitions: struct Name { or pub struct Name
    const structRegex = /^(pub\s+)?struct\s+(\w+)/gm;
    while ((match = structRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[2],
        type: "class",
        line,
        signature: match[0].trim(),
      });
    }

    // Impl blocks: impl Name { or impl Trait for Name
    const implRegex = /^impl\s+(\w+)/gm;
    while ((match = implRegex.exec(content)) !== null) {
      const line = content.substring(0, match.index).split("\n").length;
      symbols.push({
        name: match[1],
        type: "export",
        line,
        signature: match[0].trim(),
      });
    }
  }

  return symbols;
}

/**
 * Enhanced chunking that respects symbol boundaries better.
 */
export async function chunkFileEnhanced(
  content: string,
  filePath: string
): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = [];
  const lines = content.split("\n");
  const symbols = await extractSymbolsEnhanced(content, filePath);
  const symbolLines = new Set(symbols.map((s) => s.line));

  let currentChunk: string[] = [];
  let startLine = 1;
  let currentLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunk.push(line);
    currentLine = i + 1;

    const chunkContent = currentChunk.join("\n");
    const chunkLength = currentChunk.length;

    // Chunk boundary conditions:
    // 1. Reached max chunk size
    // 2. Hit a symbol boundary AND chunk is large enough
    // 3. Chunk exceeds max character limit
    const shouldChunk =
      chunkLength >= CHUNK_SIZE_LINES ||
      chunkContent.length >= MAX_CHUNK_SIZE ||
      (chunkLength >= MIN_CHUNK_SIZE &&
        symbolLines.has(currentLine + 1) &&
        chunkContent.length >= 1000);

    if (shouldChunk || i === lines.length - 1) {
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
    const fallbackSymbols = await extractSymbolsEnhanced(content, filePath);
    chunks.push({
      content,
      startLine: 1,
      endLine: lines.length,
      symbols: fallbackSymbols,
    });
  }

  return chunks;
}
