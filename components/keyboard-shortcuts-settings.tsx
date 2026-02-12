"use client";

import { useState, useEffect, useRef } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  VS_CODE_KEYMAP_PRESET,
  setStoredKeybinding,
  getKeybindingsByCategory,
  type KeybindingEntry,
} from "@/lib/keybindings";

export function KeyboardShortcutsSettings() {
  const [byCategory, setByCategory] = useState<Record<string, KeybindingEntry[]>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [capturedKeys, setCapturedKeys] = useState<string>("");
  const editInputRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  useEffect(() => {
    setByCategory(getKeybindingsByCategory());
  }, [editingId]);

  const handleStartEdit = (id: string) => {
    setEditingId(id);
    setCapturedKeys("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!editingId) return;
    e.preventDefault();
    e.stopPropagation();
    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("meta");
    if (e.shiftKey) parts.push("shift");
    if (e.altKey) parts.push("alt");
    const key = e.key === " " ? " " : e.key.toLowerCase();
    parts.push(key);
    const combo = parts.join("+");
    setCapturedKeys(combo);
  };

  const handleSave = () => {
    if (editingId && capturedKeys) {
      setStoredKeybinding(editingId, capturedKeys);
      setByCategory(getKeybindingsByCategory());
      window.dispatchEvent(new Event("keybindings-changed"));
    }
    setEditingId(null);
    setCapturedKeys("");
  };

  const handleReset = (id: string) => {
    setStoredKeybinding(id, "");
    setByCategory(getKeybindingsByCategory());
    window.dispatchEvent(new Event("keybindings-changed"));
    if (editingId === id) setEditingId(null);
  };

  const categories: { key: string; label: string }[] = [
    { key: "navigation", label: "Navigation" },
    { key: "ai", label: "AI" },
    { key: "editor", label: "Editor" },
  ];

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <Label className="text-base font-medium flex items-center gap-2">
          <Keyboard className="h-4 w-4" />
          Customize keyboard shortcuts
        </Label>
        <p className="text-sm text-muted-foreground">
          Click a shortcut to change it. Press the new key combination, then click Save. Only bindings with internal keys can be customized.
        </p>
      </section>
      {categories.map(({ key, label }) => {
        const entries = byCategory[key] ?? [];
        if (entries.length === 0) return null;
        return (
          <div key={key} className="space-y-2">
            <Label className="text-sm font-medium text-muted-foreground">{label}</Label>
            <ul className="space-y-2">
              {entries.map((entry) => {
                const isEditing = editingId === entry.id;
                const canCustomize = !!entry.internalKey || !!VS_CODE_KEYMAP_PRESET.find((e) => e.id === entry.id)?.internalKey;
                return (
                  <li key={entry.id} className="flex items-center justify-between gap-4 py-2 border-b border-border/50 last:border-0">
                    <span className="text-sm text-muted-foreground flex-1">{entry.label}</span>
                    <div className="flex items-center gap-2">
                      {canCustomize ? (
                        <>
                          <button
                            ref={isEditing ? editInputRef : undefined}
                            type="button"
                            onClick={() => !isEditing && handleStartEdit(entry.id)}
                            onKeyDown={isEditing ? handleKeyDown : undefined}
                            onBlur={() => isEditing && capturedKeys && handleSave()}
                            tabIndex={isEditing ? 0 : -1}
                            className="rounded border border-border bg-muted/50 px-3 py-1.5 font-mono text-xs min-w-[120px] text-left focus:outline-none focus:ring-2 focus:ring-primary"
                          >
                            {isEditing ? (capturedKeys || "Press keys…") : entry.keys}
                          </button>
                          {isEditing && (
                            <>
                              <Button variant="default" size="sm" onClick={handleSave} disabled={!capturedKeys}>
                                Save
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                                Cancel
                              </Button>
                            </>
                          )}
                          {!isEditing && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs"
                              onClick={() => handleReset(entry.id)}
                              title="Reset to default"
                            >
                              Reset
                            </Button>
                          )}
                        </>
                      ) : (
                        <kbd className="rounded border border-border bg-muted/60 px-2 py-1 font-mono text-xs">
                          {entry.keys}
                        </kbd>
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
  );
}
