"use client";

import { useState, useCallback, useEffect } from "react";
import {
  getKeybindingsByCategory,
  getStoredKeybinding,
  setStoredKeybinding,
  type KeybindingEntry,
} from "@/lib/keybindings";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

const CATEGORY_LABELS: Record<string, string> = {
  navigation: "Navigation",
  ai: "AI actions",
  editor: "Editor",
};

/** Bindings that support customization (have internalKey). */
const CUSTOMIZABLE_IDS = ["open-cmd-k", "apply-cmd-k-suggestion", "trigger-suggest"];

function toInternalKey(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("meta");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  const key = e.key === " " ? " " : e.key.toLowerCase();
  return mods.length > 0 ? [...mods, key].join("+") : key;
}

export function KeyboardShortcutsPanel() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [byCategory, setByCategory] = useState(getKeybindingsByCategory);

  const refresh = useCallback(() => {
    setByCategory(getKeybindingsByCategory());
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setEditingId(null);
        return;
      }
      const internal = toInternalKey(e);
      setStoredKeybinding(editingId, internal);
      setEditingId(null);
      refresh();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [editingId, refresh]);

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
                {(entries as KeybindingEntry[]).map((e) => {
                  const customizable = CUSTOMIZABLE_IDS.includes(e.id) && e.internalKey;
                  const isEditing = editingId === e.id;
                  return (
                    <li key={e.id} className="flex justify-between items-center gap-4 text-sm">
                      <span>{e.label}</span>
                      <div className="flex items-center gap-1">
                        <kbd className="shrink-0 rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">
                          {isEditing ? "Press key…" : e.keys}
                        </kbd>
                        {customizable && (
                          <>
                            {isEditing ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1.5 text-[10px]"
                                onClick={() => setEditingId(null)}
                              >
                                Cancel
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 px-1.5 text-[10px]"
                                onClick={() =>
                                  getStoredKeybinding(e.id)
                                    ? (setStoredKeybinding(e.id, ""), refresh())
                                    : setEditingId(e.id)
                                }
                              >
                                {getStoredKeybinding(e.id) ? "Reset" : "Edit"}
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
