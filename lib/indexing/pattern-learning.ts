/**
 * Pattern Learning: Remember and learn from codebase patterns.
 * Helps the system understand project conventions and patterns.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type CodebasePattern = {
  type: "import_pattern" | "naming_convention" | "file_structure" | "config_pattern";
  pattern: string;
  examples: string[];
  confidence: number;
};

export type LearnedPatterns = {
  importPatterns: CodebasePattern[];
  namingConventions: CodebasePattern[];
  fileStructure: CodebasePattern[];
  configPatterns: CodebasePattern[];
};

/**
 * Learn patterns from the codebase.
 */
export async function learnCodebasePatterns(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<LearnedPatterns> {
  const patterns: LearnedPatterns = {
    importPatterns: [],
    namingConventions: [],
    fileStructure: [],
    configPatterns: [],
  };

  // Get all files
  const { data: files } = await supabase
    .from("workspace_files")
    .select("path, content")
    .eq("workspace_id", workspaceId);

  if (!files || files.length === 0) return patterns;

  // Learn import patterns
  const importPatterns = new Map<string, number>();
  for (const file of files) {
    const content = file.content || "";
    const importMatches = content.matchAll(/import\s+.*?\s+from\s+["']([^"']+)["']/g);
    for (const match of importMatches) {
      const importPath = match[1];
      const pattern = extractImportPattern(importPath);
      importPatterns.set(pattern, (importPatterns.get(pattern) || 0) + 1);
    }
  }

  // Top import patterns
  patterns.importPatterns = Array.from(importPatterns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({
      type: "import_pattern" as const,
      pattern,
      examples: [],
      confidence: Math.min(count / files.length, 1),
    }));

  // Learn naming conventions
  const namingPatterns = analyzeNamingConventions(files);
  patterns.namingConventions = namingPatterns;

  // Learn file structure
  const structurePatterns = analyzeFileStructure(files);
  patterns.fileStructure = structurePatterns;

  // Learn config patterns
  const configFiles = files.filter((f) =>
    /(package\.json|tsconfig\.json|\.env|config\.|\.config\.)/i.test(f.path)
  );
  if (configFiles.length > 0) {
    patterns.configPatterns = [
      {
        type: "config_pattern",
        pattern: "Config files found",
        examples: configFiles.map((f) => f.path).slice(0, 5),
        confidence: 1,
      },
    ];
  }

  return patterns;
}

/**
 * Extract pattern from import path.
 */
function extractImportPattern(importPath: string): string {
  if (importPath.startsWith(".")) {
    return "relative_import";
  }
  if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
    return "alias_import";
  }
  if (!importPath.includes("/")) {
    return "package_import";
  }
  return "absolute_import";
}

/**
 * Analyze naming conventions from file names and code.
 */
function analyzeNamingConventions(files: Array<{ path: string; content: string }>): CodebasePattern[] {
  const patterns: CodebasePattern[] = [];

  // File naming patterns
  const fileNames = files.map((f) => f.path.split("/").pop() || "");
  const kebabCase = fileNames.filter((n) => /^[a-z0-9-]+\./.test(n)).length;
  const camelCase = fileNames.filter((n) => /^[a-z][a-zA-Z0-9]+\./.test(n)).length;
  const snakeCase = fileNames.filter((n) => /^[a-z][a-z0-9_]+\./.test(n)).length;

  if (kebabCase > camelCase && kebabCase > snakeCase) {
    patterns.push({
      type: "naming_convention",
      pattern: "kebab-case for files",
      examples: fileNames.filter((n) => /^[a-z0-9-]+\./.test(n)).slice(0, 3),
      confidence: kebabCase / fileNames.length,
    });
  } else if (camelCase > snakeCase) {
    patterns.push({
      type: "naming_convention",
      pattern: "camelCase for files",
      examples: fileNames.filter((n) => /^[a-z][a-zA-Z0-9]+\./.test(n)).slice(0, 3),
      confidence: camelCase / fileNames.length,
    });
  }

  return patterns;
}

/**
 * Analyze file structure patterns.
 */
function analyzeFileStructure(files: Array<{ path: string; content: string }>): CodebasePattern[] {
  const patterns: CodebasePattern[] = [];

  // Common directory patterns
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length > 1) {
      directories.add(parts[0]);
    }
  }

  const commonDirs = ["src", "lib", "components", "app", "pages", "utils", "hooks"];
  const foundDirs = commonDirs.filter((dir) => directories.has(dir));

  if (foundDirs.length > 0) {
    patterns.push({
      type: "file_structure",
      pattern: `Uses directories: ${foundDirs.join(", ")}`,
      examples: foundDirs,
      confidence: foundDirs.length / commonDirs.length,
    });
  }

  return patterns;
}

/**
 * Format learned patterns for LLM context.
 */
export function formatLearnedPatterns(patterns: LearnedPatterns): string {
  const parts: string[] = [];

  if (patterns.importPatterns.length > 0) {
    parts.push("Import patterns:");
    for (const pattern of patterns.importPatterns) {
      parts.push(`- ${pattern.pattern} (confidence: ${(pattern.confidence * 100).toFixed(0)}%)`);
    }
  }

  if (patterns.namingConventions.length > 0) {
    parts.push("\nNaming conventions:");
    for (const pattern of patterns.namingConventions) {
      parts.push(`- ${pattern.pattern}`);
      if (pattern.examples.length > 0) {
        parts.push(`  Examples: ${pattern.examples.join(", ")}`);
      }
    }
  }

  if (patterns.fileStructure.length > 0) {
    parts.push("\nFile structure:");
    for (const pattern of patterns.fileStructure) {
      parts.push(`- ${pattern.pattern}`);
    }
  }

  return parts.join("\n");
}
