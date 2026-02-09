/**
 * AST Parser using Tree-sitter for accurate code understanding.
 * Falls back to enhanced regex parsing if Tree-sitter is unavailable.
 */

import type { SymbolInfo } from "./chunker";

// Tree-sitter is not loaded in the bundle to avoid "Module not found" when packages are optional.
// extractSymbolsAST always uses the regex fallback (enhanced-chunker). To enable Tree-sitter
// later, add the packages to package.json and load them in a separate dynamic-imported module.

export type ASTSymbol = {
  name: string;
  type: "function" | "class" | "export" | "interface" | "type" | "variable";
  line: number;
  signature: string;
  startChar: number;
  endChar: number;
  children?: ASTSymbol[];
};

/**
 * Extract symbols using enhanced regex patterns (Tree-sitter not used in bundle to avoid optional deps).
 */
export async function extractSymbolsAST(
  content: string,
  filePath: string
): Promise<SymbolInfo[]> {
  const { extractSymbolsEnhancedRegex } = await import("./enhanced-chunker");
  return extractSymbolsEnhancedRegex(content, filePath);
}

/**
 * Extract imports using regex (Tree-sitter not used in bundle).
 */
export async function extractImportsAST(
  content: string,
  filePath: string
): Promise<string[]> {
  const { extractImportsFromCode } = await import("./symbol-graph");
  return extractImportsFromCode(content, filePath);
}
