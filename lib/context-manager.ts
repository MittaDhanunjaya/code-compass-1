/**
 * Enhanced context management for Chat and AI modes.
 * Tracks imports, recent files, and builds intelligent context.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type FileContext = {
  path: string;
  content: string;
  imports: string[];
  exports: string[];
  lastModified: Date;
};

/**
 * Extract imports from code content.
 */
export function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  if (language === "typescript" || language === "javascript" || language === "tsx" || language === "jsx") {
    // ES6 imports: import ... from "..."
    const es6ImportRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?["']([^"']+)["']/g;
    while ((match = es6ImportRegex.exec(content)) !== null) {
      if (match[1]) imports.push(match[1]);
    }
    
    // require() imports
    const requireRegex = /require\(["']([^"']+)["']\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      if (match[1]) imports.push(match[1]);
    }
  } else if (language === "python") {
    // Python imports
    const pythonImportRegex = /^(?:from\s+(\S+)\s+)?import\s+(\S+)/gm;
    while ((match = pythonImportRegex.exec(content)) !== null) {
      if (match[1]) imports.push(match[1]);
      if (match[2]) imports.push(match[2]);
    }
  }

  return [...new Set(imports)]; // Deduplicate
}

/**
 * Extract exports from code content.
 */
export function extractExports(content: string, language: string): string[] {
  const exports: string[] = [];
  
  if (language === "typescript" || language === "javascript" || language === "tsx" || language === "jsx") {
    // export const/let/var/function/class
    const exportRegex = /export\s+(?:const|let|var|function|class|interface|type|enum|default)\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      if (match[1]) exports.push(match[1]);
    }
  } else if (language === "python") {
    // Python __all__ or explicit exports
    const allRegex = /__all__\s*=\s*\[([^\]]+)\]/;
    const match = content.match(allRegex);
    if (match && match[1]) {
      match[1].split(",").forEach((item) => {
        const name = item.trim().replace(/["']/g, "");
        if (name) exports.push(name);
      });
    }
  }

  return [...new Set(exports)];
}

/**
 * Build enhanced context for AI prompts.
 * Includes current file, imports, recent files, and related code.
 */
export async function buildEnhancedContext(
  supabase: SupabaseClient,
  workspaceId: string,
  currentFilePath: string | null,
  currentFileContent: string | null,
  recentFilePaths: string[] = []
): Promise<string> {
  const contextParts: string[] = [];

  // Current file context
  if (currentFilePath && currentFileContent) {
    const ext = currentFilePath.split(".").pop()?.toLowerCase() || "";
    const language = ext === "ts" || ext === "tsx" ? "typescript" : ext === "js" || ext === "jsx" ? "javascript" : ext === "py" ? "python" : "plaintext";
    const imports = extractImports(currentFileContent, language);
    const exports = extractExports(currentFileContent, language);

    contextParts.push(`Current file: ${currentFilePath}`);
    if (imports.length > 0) {
      contextParts.push(`Imports: ${imports.join(", ")}`);
    }
    if (exports.length > 0) {
      contextParts.push(`Exports: ${exports.join(", ")}`);
    }
  }

  // Recent files context
  if (recentFilePaths.length > 0) {
    const recentFiles = recentFilePaths.slice(0, 5); // Last 5 files
    const { data: files } = await supabase
      .from("workspace_files")
      .select("path, content")
      .eq("workspace_id", workspaceId)
      .in("path", recentFiles);

    if (files && files.length > 0) {
      contextParts.push("\nRecent files:");
      for (const file of files) {
        if (file.path !== currentFilePath) {
          const preview = file.content?.slice(0, 200) || "";
          contextParts.push(`- ${file.path}: ${preview}...`);
        }
      }
    }
  }

  return contextParts.join("\n");
}
