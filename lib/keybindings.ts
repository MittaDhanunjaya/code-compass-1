/**
 * Editor keybindings and VS Code–style preset.
 * Phase 7.4: Supports localStorage overrides for customizable shortcuts.
 */

export type KeybindingEntry = {
  id: string;
  label: string;
  keys: string;
  /** Internal format for matching (e.g. "meta+k"). Used when customizable. */
  internalKey?: string;
  category: "navigation" | "ai" | "editor";
};

/** VS Code–aligned preset. internalKey used for customizable bindings. */
export const VS_CODE_KEYMAP_PRESET: KeybindingEntry[] = [
  { id: "go-to-definition", label: "Go to Definition", keys: "F12", internalKey: "F12", category: "navigation" },
  { id: "find-references", label: "Find References", keys: "Shift+F12", internalKey: "shift+F12", category: "navigation" },
  { id: "rename-symbol", label: "Rename Symbol", keys: "F2", internalKey: "F2", category: "navigation" },
  { id: "open-cmd-k", label: "Quick action (Refactor/Fix/Explain)", keys: "Cmd+K (Mac) / Ctrl+K (Win)", internalKey: "meta+k", category: "ai" },
  { id: "apply-cmd-k-suggestion", label: "Apply Cmd+K suggestion", keys: "Cmd+Enter (Mac) / Ctrl+Enter (Win)", internalKey: "meta+Enter", category: "ai" },
  { id: "apply-cmd-k-suggestion-tab", label: "Apply Cmd+K suggestion (Tab)", keys: "Tab", internalKey: "Tab", category: "ai" },
  { id: "dismiss-cmd-k-suggestion", label: "Dismiss Cmd+K suggestion", keys: "Escape", internalKey: "Escape", category: "ai" },
  { id: "trigger-suggest", label: "Trigger suggestion", keys: "Cmd+. (Mac) / Ctrl+. (Win)", internalKey: "meta+.", category: "editor" },
];

const STORAGE_PREFIX = "keybinding-";

/** Get stored override for a binding, or null if using default. */
export function getStoredKeybinding(id: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_PREFIX + id);
}

/** Set custom keybinding. Use empty string to reset to default. */
export function setStoredKeybinding(id: string, internalKey: string): void {
  if (typeof window === "undefined") return;
  if (internalKey) {
    localStorage.setItem(STORAGE_PREFIX + id, internalKey);
  } else {
    localStorage.removeItem(STORAGE_PREFIX + id);
  }
}

/** Get effective binding (stored override or default internalKey). */
export function getEffectiveKeybinding(id: string): string | undefined {
  const stored = getStoredKeybinding(id);
  if (stored) return stored;
  return VS_CODE_KEYMAP_PRESET.find((e) => e.id === id)?.internalKey;
}

/**
 * Check if keydown event matches the internal key string (e.g. "meta+k").
 * "meta" = Cmd on Mac, Ctrl on Win (cross-platform primary modifier).
 */
export function matchesKeybinding(e: KeyboardEvent, internalKey: string): boolean {
  const parts = internalKey.toLowerCase().split("+");
  const keyPart = parts.pop() ?? "";
  const key = keyPart === "enter" ? "enter" : keyPart === "escape" ? "escape" : keyPart === "tab" ? "tab" : keyPart;
  const keyMatch =
    e.key.toLowerCase() === key ||
    (key === "enter" && e.key === "Enter") ||
    (key === "escape" && e.key === "Escape") ||
    (key === "tab" && e.key === "Tab") ||
    (key === "." && e.key === ".") ||
    (key.length === 1 && e.key.toLowerCase() === key);
  const meta = parts.includes("meta");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const modMatch =
    (meta ? (e.metaKey || e.ctrlKey) : !e.metaKey && !e.ctrlKey) &&
    (shift ? e.shiftKey : !e.shiftKey) &&
    (alt ? e.altKey : !e.altKey);
  return keyMatch && modMatch;
}

export function getKeybindingsByCategory(): Record<string, KeybindingEntry[]> {
  const byCategory: Record<string, KeybindingEntry[]> = {};
  for (const entry of VS_CODE_KEYMAP_PRESET) {
    const cat = entry.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    const effectiveKeys = getEffectiveKeybinding(entry.id);
    byCategory[cat].push({
      ...entry,
      keys: effectiveKeys ? formatKeyForDisplay(effectiveKeys) : entry.keys,
    });
  }
  return byCategory;
}

function formatKeyForDisplay(internal: string): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const parts = internal.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const modStr = mods
    .map((m) => {
      if (m === "meta") return isMac ? "⌘" : "Ctrl";
      if (m === "ctrl") return "Ctrl";
      if (m === "shift") return "Shift";
      if (m === "alt") return isMac ? "⌥" : "Alt";
      return m;
    })
    .join("+");
  const keyStr = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
  return modStr ? `${modStr}+${keyStr}` : keyStr;
}
