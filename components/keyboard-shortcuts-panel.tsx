"use client";

import { getKeybindingsByCategory, type KeybindingEntry } from "@/lib/keybindings";
import { Label } from "@/components/ui/label";

const CATEGORY_LABELS: Record<string, string> = {
  navigation: "Navigation",
  ai: "AI actions",
  editor: "Editor",
};

export function KeyboardShortcutsPanel() {
  const byCategory = getKeybindingsByCategory();
  const order = ["navigation", "ai", "editor"] as const;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Keyboard shortcuts</Label>
        <span className="text-xs text-muted-foreground">Preset: VS Code</span>
      </div>
      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3 max-h-48 overflow-y-auto">
        {order.map((cat) => {
          const entries = byCategory[cat] ?? [];
          if (entries.length === 0) return null;
          return (
            <div key={cat}>
              <p className="text-xs font-medium text-muted-foreground mb-1">{CATEGORY_LABELS[cat] ?? cat}</p>
              <ul className="space-y-1">
                {(entries as KeybindingEntry[]).map((e) => (
                  <li key={e.id} className="flex justify-between gap-4 text-sm">
                    <span>{e.label}</span>
                    <kbd className="shrink-0 rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">
                      {e.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
