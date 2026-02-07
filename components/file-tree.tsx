"use client";

import { useEffect, useState } from "react";
import {
  ChevronRight,
  Database,
  File,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { buildFileTree, type FileTreeNode } from "@/lib/file-tree";
import { useEditor } from "@/lib/editor-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FileTreeProps = {
  workspaceId: string | null;
};

export function FileTree({ workspaceId }: FileTreeProps) {
  const [paths, setPaths] = useState<{ path: string; updated_at: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [createParent, setCreateParent] = useState("");
  const [createName, setCreateName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePath, setRenamePath] = useState("");
  const [renameName, setRenameName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const { openFile, getTab } = useEditor();

  const isDirty = (path: string) => getTab(path)?.dirty ?? false;

  async function fetchFiles() {
    if (!workspaceId) return;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`);
      if (res.ok) {
        const data = await res.json();
        setPaths(data);
      } else {
        setPaths([]);
      }
    } catch {
      setPaths([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false);
      setPaths([]);
      return;
    }
    setLoading(true);
    fetchFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // Listen for file tree refresh events (e.g., after Agent execution)
  useEffect(() => {
    const handleRefresh = () => {
      if (workspaceId) {
        fetchFiles();
      }
    };
    window.addEventListener("refresh-file-tree", handleRefresh);
    return () => {
      window.removeEventListener("refresh-file-tree", handleRefresh);
    };
  }, [workspaceId]);

  const tree = buildFileTree(paths.map((p) => p.path));

  async function handleCreateFile(path: string, isFolder: boolean) {
    if (!workspaceId) return;
    setError(null);
    setSubmitting(true);
    const fullPath = createParent
      ? `${createParent.replace(/\/$/, "")}/${path}`
      : path;
    const finalPath = isFolder ? fullPath.replace(/\/?$/, "/") : fullPath;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: finalPath, content: "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create");
      setCreateOpen(false);
      setCreateName("");
      setCreateParent("");
      fetchFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRename(oldPath: string, newName: string) {
    if (!workspaceId) return;
    setError(null);
    setSubmitting(true);
    const parts = oldPath.split("/").filter(Boolean);
    const parent =
      parts.length > 1
        ? parts.slice(0, -1).join("/") + "/"
        : oldPath.endsWith("/")
          ? ""
          : "";
    const newPath =
      parent + newName + (oldPath.endsWith("/") ? "/" : "");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath, newPath }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to rename");
      setRenameOpen(false);
      setRenamePath("");
      setRenameName("");
      fetchFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(path: string) {
    if (!workspaceId) return;
    const label = path.endsWith("/") ? `folder "${path}"` : `file "${path}"`;
    if (!confirm(`Delete ${label}?`)) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete");
      fetchFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  async function handleFileClick(path: string) {
    if (!workspaceId) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`
    );
    if (res.ok) {
      const data = await res.json();
      openFile(path, data.content ?? "");
    }
  }

  async function handleRebuildIndex() {
    if (!workspaceId) return;
    setIndexing(true);
    setError(null);
    try {
      const res = await fetch("/api/index/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Index rebuild failed");
      alert(`Index rebuilt: ${data.message || "Success"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rebuild index");
    } finally {
      setIndexing(false);
    }
  }

  if (!workspaceId) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">
        Select a workspace
      </div>
    );
  }

  if (loading) {
    return (
      <div className="px-2 py-2 text-xs text-muted-foreground">
        Loading files…
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-2">
        <p className="text-xs font-medium text-muted-foreground">Files</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => fetchFiles()}
            title="Refresh file tree"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleRebuildIndex}
            disabled={indexing}
            title="Rebuild codebase index (for @codebase search)"
          >
            <Database className={`h-4 w-4 ${indexing ? "animate-pulse" : ""}`} />
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => {
                setError(null);
                setCreateParent("");
                setCreateName("");
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create file or folder</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {createParent && (
                <p className="text-xs text-muted-foreground">
                  In: {createParent}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="create-name">Name</Label>
                <Input
                  id="create-name"
                  placeholder="file.ts or folder/"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const name = createName.trim();
                      const isFolder = name.endsWith("/");
                      if (name) handleCreateFile(name, isFolder);
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  End with / for folder
                </p>
              </div>
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const name = createName.trim();
                  const isFolder = name.endsWith("/");
                  if (name) handleCreateFile(name, isFolder);
                }}
                disabled={submitting || !createName.trim()}
              >
                {submitting ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
      <TreeNode
        nodes={tree}
        expanded={expanded}
        isDirty={isDirty}
        onToggle={(path) => {
          setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          });
        }}
        onFileClick={handleFileClick}
        onRename={(path, name) => {
          setRenamePath(path);
          setRenameName(name);
          setRenameOpen(true);
          setError(null);
        }}
        onDelete={handleDelete}
        onAddInFolder={(parent) => {
          setCreateParent(parent);
          setCreateName("");
          setCreateOpen(true);
        }}
      />
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename-name">New name</Label>
              <Input
                id="rename-name"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renamePath && renameName.trim()) {
                    handleRename(renamePath, renameName.trim());
                  }
                }}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (renamePath && renameName.trim()) {
                  handleRename(renamePath, renameName.trim());
                }
              }}
              disabled={submitting || !renameName.trim()}
            >
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TreeNode({
  nodes,
  expanded,
  isDirty,
  onToggle,
  onFileClick,
  onRename,
  onDelete,
  onAddInFolder,
  depth = 0,
}: {
  nodes: FileTreeNode[];
  expanded: Set<string>;
  isDirty: (path: string) => boolean;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
  onAddInFolder: (parent: string) => void;
  depth?: number;
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => (
        <div key={node.path}>
          <div
            className="group flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-accent/50"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {node.isFolder ? (
              <>
                <button
                  type="button"
                  className="flex shrink-0"
                  onClick={() => onToggle(node.path)}
                >
                  {expanded.has(node.path) ? (
                    <ChevronRight className="h-4 w-4 rotate-90" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                {expanded.has(node.path) ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                )}
                <span className="flex-1 truncate">{node.name}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onClick={() => onAddInFolder(node.path)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add file
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onRename(node.path, node.name)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete(node.path)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <span className="w-4 shrink-0" />
                <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  className="flex flex-1 items-center gap-1.5 truncate text-left"
                  onClick={() => onFileClick(node.path)}
                >
                  {isDirty(node.path) && (
                    <span className="shrink-0 text-[10px] font-medium text-amber-500" title="Modified">
                      M
                    </span>
                  )}
                  <span className="truncate">{node.name}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => onRename(node.path, node.name)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete(node.path)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
          {node.isFolder && expanded.has(node.path) && node.children.length > 0 && (
            <TreeNode
              nodes={node.children}
              expanded={expanded}
              isDirty={isDirty}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onRename={onRename}
              onDelete={onDelete}
              onAddInFolder={onAddInFolder}
              depth={depth + 1}
            />
          )}
        </div>
      ))}
    </div>
  );
}
