/**
 * Editor keybindings and VS Code–style preset.
 * Used by the Keyboard shortcuts panel; Monaco bindings are registered in editor-area.tsx.
 */

export type KeybindingEntry = {
  id: string;
  label: string;
  keys: string;
  category: "navigation" | "ai" | "editor";
};

/** VS Code–aligned preset: labels and keys we expose (Monaco uses same keys where applicable). */
export const VS_CODE_KEYMAP_PRESET: KeybindingEntry[] = [
  { id: "go-to-definition", label: "Go to Definition", keys: "F12", category: "navigation" },
  { id: "find-references", label: "Find References", keys: "Shift+F12", category: "navigation" },
  { id: "rename-symbol", label: "Rename Symbol", keys: "F2", category: "navigation" },
  { id: "open-cmd-k", label: "Quick action (Refactor/Fix/Explain)", keys: "Cmd+K (Mac) / Ctrl+K (Win)", category: "ai" },
  { id: "apply-cmd-k-suggestion", label: "Apply Cmd+K suggestion", keys: "Cmd+Enter (Mac) / Ctrl+Enter (Win)", category: "ai" },
  { id: "apply-cmd-k-suggestion-tab", label: "Apply Cmd+K suggestion (Tab)", keys: "Tab", category: "ai" },
  { id: "dismiss-cmd-k-suggestion", label: "Dismiss Cmd+K suggestion", keys: "Escape", category: "ai" },
  { id: "trigger-suggest", label: "Trigger suggestion", keys: "Cmd+. (Mac) / Ctrl+. (Win)", category: "editor" },
];

export function getKeybindingsByCategory(): Record<string, KeybindingEntry[]> {
  const byCategory: Record<string, KeybindingEntry[]> = {};
  for (const entry of VS_CODE_KEYMAP_PRESET) {
    const cat = entry.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(entry);
  }
  return byCategory;
}
