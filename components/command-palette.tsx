"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { FilePicker } from "@/components/file-picker";
import { SearchPanel } from "@/components/search-panel";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type CommandId =
  | "goToDefinition"
  | "findReferences"
  | "renameSymbol"
  | "runAgentOnCurrentFile"
  | "debugFromLog"
  | "reviewAllChanges"
  | "openFile"
  | "searchInFiles";

const COMMANDS: { id: CommandId; label: string; keys?: string }[] = [
  { id: "goToDefinition", label: "Go to Definition", keys: "F12" },
  { id: "findReferences", label: "Find References", keys: "Shift+F12" },
  { id: "renameSymbol", label: "Rename Symbol", keys: "F2" },
  { id: "runAgentOnCurrentFile", label: "Run Agent on Current File" },
  { id: "debugFromLog", label: "Debug from Log (last error)" },
  { id: "reviewAllChanges", label: "Review All Changes" },
  { id: "openFile", label: "Go to File...", keys: "Ctrl+P" },
  { id: "searchInFiles", label: "Search in Files", keys: "Ctrl+Shift+F" },
];

/**
 * Full command palette (Ctrl+Shift+P) plus Ctrl+P (file picker) and Ctrl+Shift+F (search).
 * Dispatches "command-palette-run" with { commandId } for editor/agent commands.
 */
export function CommandPalette() {
  const pathname = usePathname();
  const workspaceId = pathname.startsWith("/app/")
    ? pathname.replace("/app/", "").split("/")[0]
    : null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = COMMANDS.filter(
    (c) => !query.trim() || c.label.toLowerCase().includes(query.trim().toLowerCase())
  );
  const selectedId = filtered[selectedIndex]?.id ?? null;

  const runCommand = useCallback(
    (id: CommandId) => {
      if (id === "openFile") {
        setPaletteOpen(false);
        if (workspaceId) setPickerOpen(true);
        return;
      }
      if (id === "searchInFiles") {
        setPaletteOpen(false);
        if (workspaceId) setSearchOpen(true);
        return;
      }
      setPaletteOpen(false);
      window.dispatchEvent(new CustomEvent("command-palette-run", { detail: { commandId: id } }));
    },
    [workspaceId]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        if (workspaceId) {
          if (e.shiftKey) {
            setPaletteOpen(true);
            setQuery("");
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
          } else {
            setPickerOpen(true);
          }
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        if (workspaceId) setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [workspaceId]);

  useEffect(() => {
    if (!paletteOpen) return;
    setSelectedIndex(0);
  }, [paletteOpen, query]);

  useEffect(() => {
    if (!paletteOpen || filtered.length === 0) return;
    const i = Math.min(selectedIndex, filtered.length - 1);
    setSelectedIndex(i);
  }, [filtered.length, paletteOpen, selectedIndex]);

  useEffect(() => {
    if (!paletteOpen || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-command-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [paletteOpen, selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedId) runCommand(selectedId);
    } else if (e.key === "Escape") {
      setPaletteOpen(false);
    }
  };

  return (
    <>
      <FilePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        workspaceId={workspaceId}
      />
      <SearchPanel
        open={searchOpen}
        onOpenChange={setSearchOpen}
        workspaceId={workspaceId}
      />
      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent className="sm:max-w-xl p-0 gap-0 overflow-hidden">
          <div className="flex items-center border-b border-border px-2">
            <span className="text-muted-foreground pl-2 text-sm">⌘⇧P</span>
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command or search..."
              className="border-0 shadow-none focus-visible:ring-0 rounded-none h-11"
            />
          </div>
          <div
            ref={listRef}
            className="max-h-[min(60vh,320px)] overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No matching commands.</p>
            ) : (
              filtered.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  data-command-index={i}
                  onClick={() => runCommand(cmd.id)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 ${
                    i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
                  }`}
                >
                  <span>{cmd.label}</span>
                  {cmd.keys && (
                    <kbd className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {cmd.keys}
                    </kbd>
                  )}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
