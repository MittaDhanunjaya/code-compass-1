/**
 * Symbol Graph: Builds relationships between symbols across files.
 * This enables intelligent codebase understanding without hardcoded rules.
 */

import type { SymbolInfo } from "./chunker";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SymbolReference = {
  symbolName: string;
  symbolType: "function" | "class" | "export" | "variable";
  filePath: string;
  line: number;
  references: Array<{
    filePath: string;
    line: number;
    context: string; // Surrounding code
  }>;
};

export type FileDependencies = {
  filePath: string;
  imports: string[]; // Imported modules/paths
  exports: string[]; // Exported symbols
  dependsOn: string[]; // Files this file imports from
  dependedBy: string[]; // Files that import this file
};

/**
 * Extract imports from code to understand file dependencies.
 */
export function extractImportsFromCode(content: string, filePath: string): string[] {
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isTS = ext === "ts" || ext === "tsx";
  const isJS = ext === "js" || ext === "jsx";
  const isPython = ext === "py";

  if (isTS || isJS) {
    // ES6 imports: import ... from "path"
    const es6ImportRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?["']([^"']+)["']/g;
    while ((match = es6ImportRegex.exec(content)) !== null) {
      if (match[1] && !match[1].startsWith(".") && !match[1].startsWith("/")) {
        // External package
        imports.push(match[1]);
      } else if (match[1]) {
        // Relative import - normalize it
        imports.push(match[1]);
      }
    }

    // require() imports
    const requireRegex = /require\(["']([^"']+)["']\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      if (match[1]) {
        imports.push(match[1]);
      }
    }
  } else if (isPython) {
    // Python imports
    const pythonImportRegex = /^(?:from\s+(\S+)\s+)?import\s+(\S+)/gm;
    while ((match = pythonImportRegex.exec(content)) !== null) {
      if (match[1]) imports.push(match[1]);
      if (match[2]) imports.push(match[2]);
    }
  }

  return [...new Set(imports)];
}

/**
 * Find files that reference a specific symbol.
 */
export async function findSymbolReferences(
  supabase: SupabaseClient,
  workspaceId: string,
  symbolName: string
): Promise<SymbolReference[]> {
  const { data: chunks } = await supabase
    .from("code_chunks")
    .select("file_path, content, symbols, chunk_index")
    .eq("workspace_id", workspaceId);

  if (!chunks) return [];

  const _references: SymbolReference[] = [];
  const symbolMap = new Map<string, SymbolReference>();

  for (const chunk of chunks) {
    const symbols = (chunk.symbols as SymbolInfo[]) || [];
    const content = chunk.content || "";
    const lines = content.split("\n");

    // Find symbol definitions
    for (const symbol of symbols) {
      if (symbol.name === symbolName) {
        const key = `${chunk.file_path}:${symbol.name}`;
        if (!symbolMap.has(key)) {
          symbolMap.set(key, {
            symbolName: symbol.name,
            symbolType: symbol.type,
            filePath: chunk.file_path,
            line: symbol.line,
            references: [],
          });
        }
      }
    }

    // Find symbol usages (references)
    const symbolRegex = new RegExp(`\\b${symbolName}\\b`, "g");
    let match;
    while ((match = symbolRegex.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const lineStart = Math.max(0, lineNum - 2);
      const lineEnd = Math.min(lines.length, lineNum + 2);
      const context = lines.slice(lineStart, lineEnd).join("\n");

      // Check if this is a definition (already handled) or a reference
      const isDefinition = symbols.some(
        (s) => s.name === symbolName && s.line === lineNum
      );

      if (!isDefinition) {
        // Add to all symbol definitions of this name
        for (const [_key, ref] of symbolMap.entries()) {
          if (ref.symbolName === symbolName) {
            ref.references.push({
              filePath: chunk.file_path,
              line: lineNum,
              context,
            });
          }
        }
      }
    }
  }

  return Array.from(symbolMap.values());
}

/**
 * Build file dependency graph from imports/exports.
 */
export async function buildFileDependencyGraph(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<Map<string, FileDependencies>> {
  const { data: files } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  if (!files) return new Map();

  const graph = new Map<string, FileDependencies>();

  // First pass: extract imports and exports
  for (const file of files) {
    const imports = extractImportsFromCode(file.content || "", file.path);
    const exports = extractExportsFromCode(file.content || "", file.path);

    graph.set(file.path, {
      filePath: file.path,
      imports,
      exports,
      dependsOn: [],
      dependedBy: [],
    });
  }

  // Second pass: resolve dependencies
  for (const [filePath, deps] of graph.entries()) {
    for (const imp of deps.imports) {
      // Try to resolve import to actual file path
      const resolvedPath = resolveImportPath(filePath, imp, Array.from(graph.keys()));
      if (resolvedPath && resolvedPath !== filePath) {
        deps.dependsOn.push(resolvedPath);
        const targetDeps = graph.get(resolvedPath);
        if (targetDeps) {
          targetDeps.dependedBy.push(filePath);
        }
      }
    }
  }

  return graph;
}

/**
 * Extract exports from code.
 */
function extractExportsFromCode(content: string, filePath: string): string[] {
  const exports: string[] = [];
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isTS = ext === "ts" || ext === "tsx";
  const isJS = ext === "js" || ext === "jsx";

  if (isTS || isJS) {
    // export const/let/var/function/class
    const exportRegex = /export\s+(?:const|let|var|function|class|interface|type|enum|default)\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      if (match[1]) exports.push(match[1]);
    }

    // export { ... }
    const namedExportRegex = /export\s+\{([^}]+)\}/g;
    while ((match = namedExportRegex.exec(content)) !== null) {
      const names = match[1].split(",").map((n) => n.trim().split(" as ")[0].trim());
      exports.push(...names);
    }
  }

  return [...new Set(exports)];
}

/**
 * Resolve import path to actual file path.
 */
function resolveImportPath(
  fromFile: string,
  importPath: string,
  allFiles: string[]
): string | null {
  // Handle relative imports
  if (importPath.startsWith(".")) {
    const dir = fromFile.substring(0, fromFile.lastIndexOf("/"));
    const resolved = resolveRelativePath(dir, importPath);
    
    // Try different extensions
    const extensions = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (allFiles.includes(candidate)) {
        return candidate;
      }
    }
  }

  // Handle absolute imports (node_modules, etc.)
  // For now, return null - could be enhanced with package.json resolution
  return null;
}

/**
 * Resolve relative path.
 */
function resolveRelativePath(fromDir: string, relativePath: string): string {
  const parts = relativePath.split("/");
  let current = fromDir;

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      current = current.substring(0, current.lastIndexOf("/"));
    } else {
      current = current ? `${current}/${part}` : part;
    }
  }

  return current;
}

/**
 * Find related files based on imports, exports, and symbol usage.
 */
export async function findRelatedFiles(
  supabase: SupabaseClient,
  workspaceId: string,
  filePath: string,
  maxResults: number = 10
): Promise<string[]> {
  const graph = await buildFileDependencyGraph(supabase, workspaceId);
  const fileDeps = graph.get(filePath);
  
  if (!fileDeps) return [];

  const related = new Set<string>();

  // Files this file imports from
  fileDeps.dependsOn.forEach((dep) => related.add(dep));

  // Files that import this file
  fileDeps.dependedBy.forEach((dep) => related.add(dep));

  // Files that import the same modules (similar dependencies)
  for (const [otherPath, otherDeps] of graph.entries()) {
    if (otherPath === filePath) continue;
    
    const commonImports = fileDeps.imports.filter((imp) =>
      otherDeps.imports.includes(imp)
    );
    if (commonImports.length > 0) {
      related.add(otherPath);
    }
  }

  return Array.from(related).slice(0, maxResults);
}
