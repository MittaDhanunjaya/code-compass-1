"use client";

import { useCallback, useEffect, useState } from "react";
import { File, Loader2 } from "lucide-react";
import { useEditor } from "@/lib/editor-context";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SearchResult = {
  path: string;
  lineNumber: number;
  line: string;
};

type SearchPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
};

export function SearchPanel({
  open,
  onOpenChange,
  workspaceId,
}: SearchPanelProps) {
  const { openFile } = useEditor();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);

  const search = useCallback(async () => {
    if (!workspaceId || !query.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/files/search?q=${encodeURIComponent(query.trim())}`
      );
      if (res.ok) {
        const data = await res.json();
        setResults(data);
        setSelected(0);
      } else {
        setResults([]);
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        search();
      } else if (e.key === "ArrowDown" && results.length > 0) {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, results.length - 1));
      } else if (e.key === "ArrowUp" && results.length > 0) {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter" && results.length > 0 && document.activeElement?.tagName !== "INPUT") {
        const r = results[selected];
        if (r) handleSelect(r);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, results, selected]);

  async function handleSelect(r: SearchResult) {
    if (!workspaceId) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(r.path)}`
    );
    if (res.ok) {
      const data = await res.json();
      openFile(r.path, data.content ?? "");
      onOpenChange(false);
    }
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0 gap-0">
        <DialogHeader className="p-3 pb-0">
          <DialogTitle className="text-sm font-medium">
            Search in files (Ctrl+Shift+F)
          </DialogTitle>
        </DialogHeader>
        <div className="p-3">
          <div className="flex gap-2">
            <Input
              placeholder="Search..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              className="flex-1"
              autoFocus
            />
            <button
              type="button"
              className="rounded border border-input bg-background px-4 py-2 text-sm hover:bg-accent"
              onClick={search}
              disabled={loading || !query.trim()}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
            </button>
          </div>
          <div className="mt-2 max-h-72 overflow-y-auto rounded border border-border">
            {results.length === 0 && !loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {query.trim() ? "No matches" : "Enter a search term"}
              </div>
            ) : (
              results.map((r, i) => (
                <button
                  key={`${r.path}:${r.lineNumber}:${i}`}
                  type="button"
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent ${
                    i === selected ? "bg-accent" : ""
                  }`}
                  onClick={() => handleSelect(r)}
                >
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <File className="h-4 w-4 shrink-0" />
                    {r.path}:{r.lineNumber}
                  </span>
                  <span className="truncate font-mono text-xs">{r.line}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
