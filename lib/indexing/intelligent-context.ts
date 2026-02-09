/**
 * Intelligent Context Builder: Automatically discovers relevant code
 * based on codebase structure, not hardcoded rules.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { findRelatedFiles, findSymbolReferences, buildFileDependencyGraph } from "./symbol-graph";
import { extractImportsFromCode } from "./symbol-graph";

export type IntelligentContext = {
  currentFile: {
    path: string;
    content: string;
    symbols: Array<{ name: string; type: string; line: number }>;
    imports: string[];
    exports: string[];
  } | null;
  relatedFiles: Array<{
    path: string;
    content: string;
    reason: string; // Why this file is relevant
  }>;
  symbolReferences: Array<{
    symbolName: string;
    references: Array<{ filePath: string; line: number; context: string }>;
  }>;
  codebaseStructure: {
    totalFiles: number;
    mainEntryPoints: string[]; // Files that are imported by many others
    configFiles: string[]; // package.json, tsconfig.json, etc.
  };
};

/**
 * Build intelligent context for a task.
 * Automatically discovers relevant files based on codebase structure.
 */
export async function buildIntelligentContext(
  supabase: SupabaseClient,
  workspaceId: string,
  currentFilePath: string | null,
  query?: string // Optional query to guide discovery
): Promise<IntelligentContext> {
  const context: IntelligentContext = {
    currentFile: null,
    relatedFiles: [],
    symbolReferences: [],
    codebaseStructure: {
      totalFiles: 0,
      mainEntryPoints: [],
      configFiles: [],
    },
  };

  // Get all files
  const { data: allFiles } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  if (!allFiles) return context;

  context.codebaseStructure.totalFiles = allFiles.length;

  // Identify config files
  context.codebaseStructure.configFiles = allFiles
    .map((f) => f.path)
    .filter((p) =>
      /(package\.json|tsconfig\.json|\.env|vite\.config|next\.config|webpack\.config|\.gitignore|README)/i.test(
        p
      )
    );

  // Build dependency graph to find main entry points
  const graph = await buildFileDependencyGraph(supabase, workspaceId);
  const importCounts = new Map<string, number>();
  for (const deps of graph.values()) {
    for (const dep of deps.dependedBy) {
      importCounts.set(dep, (importCounts.get(dep) || 0) + 1);
    }
  }
  context.codebaseStructure.mainEntryPoints = Array.from(importCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path]) => path);

  // Get current file if specified
  if (currentFilePath) {
    const currentFile = allFiles.find((f) => f.path === currentFilePath);
    if (currentFile) {
      const imports = extractImportsFromCode(currentFile.content || "", currentFilePath);
      
      // Get symbols from code_chunks
      const { data: chunks } = await supabase
        .from("code_chunks")
        .select("symbols")
        .eq("workspace_id", workspaceId)
        .eq("file_path", currentFilePath)
        .limit(1);

      const symbols = chunks?.[0]?.symbols || [];

      context.currentFile = {
        path: currentFilePath,
        content: currentFile.content || "",
        symbols: symbols as Array<{ name: string; type: string; line: number }>,
        imports,
        exports: [], // Could extract from symbols
      };

      // Find related files automatically
      const relatedPaths = await findRelatedFiles(supabase, workspaceId, currentFilePath, 10);
      
      for (const relatedPath of relatedPaths) {
        const relatedFile = allFiles.find((f) => f.path === relatedPath);
        if (relatedFile) {
          const reason = graph.get(currentFilePath)?.dependsOn.includes(relatedPath)
            ? "Imported by current file"
            : graph.get(currentFilePath)?.dependedBy.includes(relatedPath)
            ? "Imports current file"
            : "Shares dependencies";
          
          context.relatedFiles.push({
            path: relatedPath,
            content: relatedFile.content || "",
            reason,
          });
        }
      }

      // Find symbol references if query mentions a symbol
      if (query) {
        const symbolMatch = query.match(/\b(\w+)\b/);
        if (symbolMatch) {
          const symbolName = symbolMatch[1];
          const references = await findSymbolReferences(supabase, workspaceId, symbolName);
          context.symbolReferences = references.map((ref) => ({
            symbolName: ref.symbolName,
            references: ref.references,
          }));
        }
      }
    }
  }

  return context;
}

/**
 * Format intelligent context for LLM consumption.
 */
export function formatIntelligentContext(context: IntelligentContext): string {
  const parts: string[] = [];

  if (context.currentFile) {
    parts.push(`Current file: ${context.currentFile.path}`);
    if (context.currentFile.imports.length > 0) {
      parts.push(`Imports: ${context.currentFile.imports.join(", ")}`);
    }
    if (context.currentFile.symbols.length > 0) {
      const symbolList = context.currentFile.symbols
        .slice(0, 10)
        .map((s) => `${s.name} (${s.type})`)
        .join(", ");
      parts.push(`Symbols: ${symbolList}`);
    }
  }

  if (context.relatedFiles.length > 0) {
    parts.push("\nRelated files (discovered automatically):");
    for (const file of context.relatedFiles.slice(0, 5)) {
      parts.push(`- ${file.path} (${file.reason})`);
      parts.push(`  ${file.content.slice(0, 200)}...`);
    }
  }

  if (context.symbolReferences.length > 0) {
    parts.push("\nSymbol references:");
    for (const ref of context.symbolReferences.slice(0, 3)) {
      parts.push(`- ${ref.symbolName} is used in:`);
      for (const usage of ref.references.slice(0, 3)) {
        parts.push(`  ${usage.filePath}:${usage.line}`);
      }
    }
  }

  if (context.codebaseStructure.mainEntryPoints.length > 0) {
    parts.push("\nCodebase structure:");
    parts.push(`Main entry points: ${context.codebaseStructure.mainEntryPoints.join(", ")}`);
  }

  return parts.join("\n");
}
