"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { File } from "lucide-react";
import { useEditor } from "@/lib/editor-context";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type FilePickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
};

export function FilePicker({
  open,
  onOpenChange,
  workspaceId,
}: FilePickerProps) {
  const { openFile } = useEditor();
  const [paths, setPaths] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);

  const filteredPaths = useMemo(() => {
    if (!query.trim()) return paths;
    const q = query.toLowerCase().trim();
    const parts = q.split(/\s+/);
    return paths.filter((path) => {
      const pathLower = path.toLowerCase();
      return parts.every((part) => pathLower.includes(part));
    });
  }, [paths, query]);

  const fetchPaths = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`);
      if (res.ok) {
        const data = await res.json();
        setPaths(
          (data as { path: string }[])
            .filter((p) => !p.path.endsWith("/"))
            .map((p) => p.path)
        );
      } else {
        setPaths([]);
      }
    } catch {
      setPaths([]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (open && workspaceId) {
      setQuery("");
      setSelected(0);
      fetchPaths();
    }
  }, [open, workspaceId, fetchPaths]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onOpenChange(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected((s) => Math.min(s + 1, filteredPaths.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const path = filteredPaths[selected];
        if (path) {
          handleSelect(path);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filteredPaths, selected]);

  async function handleSelect(path: string) {
    if (!workspaceId) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`
    );
    if (res.ok) {
      const data = await res.json();
      openFile(path, data.content ?? "");
      onOpenChange(false);
    }
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 gap-0">
        <DialogHeader className="p-3 pb-0">
          <DialogTitle className="text-sm font-medium">
            Go to file (Ctrl+P)
          </DialogTitle>
        </DialogHeader>
        <div className="p-3">
          <Input
            placeholder="Type to search files..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-2"
            autoFocus
          />
          <div className="max-h-64 overflow-y-auto rounded border border-border">
            {loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : filteredPaths.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                {query ? "No matching files" : "No files in workspace"}
              </div>
            ) : (
              filteredPaths.map((path, i) => (
                <button
                  key={path}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                    i === selected ? "bg-accent" : ""
                  }`}
                  onClick={() => handleSelect(path)}
                >
                  <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{path}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
