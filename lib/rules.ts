/**
 * Rules system for project conventions.
 * Reads .aiforge-rules file from workspace root and enforces conventions.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectRules = {
  rules: string[];
  rawContent: string;
};

const RULES_FILE_PATH = ".aiforge-rules";

/**
 * Load rules from workspace root.
 */
export async function loadRules(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<ProjectRules | null> {
  try {
    const { data: file, error } = await supabase
      .from("workspace_files")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("path", RULES_FILE_PATH)
      .single();

    if (error || !file) {
      return null;
    }

    const content = file.content || "";
    const rules = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    return {
      rules,
      rawContent: content,
    };
  } catch {
    return null;
  }
}

/**
 * Format rules for LLM prompt.
 */
export function formatRulesForPrompt(rules: ProjectRules | null): string {
  if (!rules || rules.rules.length === 0) {
    return "";
  }

  return `\n\nProject Rules (.aiforge-rules):\n${rules.rules.map((r) => `- ${r}`).join("\n")}\n\nYou MUST follow these rules. If you deviate, explain why briefly.`;
}

/**
 * Check if rules file exists in workspace.
 */
export async function hasRulesFile(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("workspace_files")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("path", RULES_FILE_PATH)
    .single();

  return !!data;
}
