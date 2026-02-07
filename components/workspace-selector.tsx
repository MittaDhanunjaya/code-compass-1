"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Download, FolderOpen, Github, GitBranch, GitPullRequest, MoreHorizontal, Pencil, Plus, Settings, Trash2 } from "lucide-react";
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

type Workspace = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  safe_edit_mode?: boolean;
  github_repo_url?: string | null;
  github_default_branch?: string | null;
  github_owner?: string | null;
  github_repo?: string | null;
  github_is_private?: boolean | null;
  github_current_branch?: string | null;
};

type RepoItem = {
  id: number;
  fullName: string;
  owner: string;
  repo: string;
  private: boolean;
  defaultBranch: string;
  url: string;
};

export function WorkspaceSelector() {
  const pathname = usePathname();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"empty" | "github" | "myRepos">("empty");
  const [createRepoUrl, setCreateRepoUrl] = useState("");
  const [createBranch, setCreateBranch] = useState("main");
  const [myRepos, setMyRepos] = useState<RepoItem[]>([]);
  const [myReposLoading, setMyReposLoading] = useState(false);
  const [selectedMyRepo, setSelectedMyRepo] = useState<RepoItem | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsWorkspace, setSettingsWorkspace] = useState<Workspace | null>(null);
  const [reimporting, setReimporting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [gitStatus, setGitStatus] = useState<{ currentBranch: string; entries: { path: string; status: string }[] } | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [createBranchLoading, setCreateBranchLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitPushLoading, setCommitPushLoading] = useState(false);
  const [commitPushConfirmOpen, setCommitPushConfirmOpen] = useState(false);
  const [lastPrUrl, setLastPrUrl] = useState<string | null>(null);
  const [renameWorkspace, setRenameWorkspace] = useState<Workspace | null>(null);
  const [newName, setNewName] = useState("");
  const [createName, setCreateName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [testsFailingForWorkspace, setTestsFailingForWorkspace] = useState<string | null>(null);
  const [savingSafeEdit, setSavingSafeEdit] = useState(false);

  const workspaceId = pathname.startsWith("/app/")
    ? pathname.replace("/app/", "").split("/")[0]
    : null;

  async function fetchWorkspaces() {
    try {
      const res = await fetch("/api/workspaces");
      if (res.ok) {
        const data = await res.json();
        setWorkspaces(data);
      }
    } catch {
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  useEffect(() => {
    const handler = (e: CustomEvent<{ workspaceId: string; failing: boolean }>) => {
      const { workspaceId: wsId, failing } = e.detail ?? {};
      setTestsFailingForWorkspace(failing && wsId ? wsId : null);
    };
    window.addEventListener("workspace-tests-status" as keyof WindowEventMap, handler as EventListener);
    return () => window.removeEventListener("workspace-tests-status" as keyof WindowEventMap, handler as EventListener);
  }, []);

  async function loadMyRepos() {
    setMyReposLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/github/repos");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load repos");
      setMyRepos(data.repos ?? []);
      setSelectedMyRepo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load repos");
      setMyRepos([]);
    } finally {
      setMyReposLoading(false);
    }
  }

  async function handleCreate() {
    setError(null);
    setCreateSuccess(null);
    setSubmitting(true);
    try {
      const body: {
        name: string;
        githubRepoUrl?: string;
        githubBranch?: string;
        fromMyRepo?: { owner: string; repo: string; defaultBranch: string; isPrivate: boolean };
      } = {
        name: createName || "Untitled Workspace",
      };
      if (createMode === "github" && createRepoUrl.trim()) {
        body.githubRepoUrl = createRepoUrl.trim();
        body.githubBranch = (createBranch.trim() || "main").replace(/^\s+|\s+$/g, "") || "main";
      }
      if (createMode === "myRepos" && selectedMyRepo) {
        body.fromMyRepo = {
          owner: selectedMyRepo.owner,
          repo: selectedMyRepo.repo,
          defaultBranch: selectedMyRepo.defaultBranch,
          isPrivate: selectedMyRepo.private,
        };
      }
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create");
      const filesImported = data.filesImported;
      const { filesImported: _fi, ...ws } = data;
      setCreateOpen(false);
      setCreateName("");
      setCreateRepoUrl("");
      setCreateBranch("main");
      setCreateMode("empty");
      setSelectedMyRepo(null);
      setWorkspaces((prev) => [
        {
          ...ws,
          safe_edit_mode: ws.safe_edit_mode ?? true,
          github_repo_url: ws.github_repo_url ?? null,
          github_default_branch: ws.github_default_branch ?? null,
          github_owner: ws.github_owner ?? null,
          github_repo: ws.github_repo ?? null,
          github_is_private: ws.github_is_private ?? null,
          github_current_branch: ws.github_current_branch ?? null,
        },
        ...prev,
      ]);
      try {
        await fetch(`/api/workspaces/${data.id}/set-active`, { method: "POST" });
      } catch {
        // non-blocking
      }
      router.push(`/app/${data.id}`);
      if (typeof filesImported === "number") {
        setCreateSuccess(`Imported ${filesImported} file(s) from GitHub.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create workspace");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRename() {
    if (!renameWorkspace) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/workspaces/${renameWorkspace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() || "Untitled Workspace" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to rename");
      setRenameOpen(false);
      setRenameWorkspace(null);
      setNewName("");
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === renameWorkspace.id ? { ...w, ...data } : w))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename workspace");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(ws: Workspace) {
    if (!confirm(`Delete workspace "${ws.name}"?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      setWorkspaces((prev) => prev.filter((w) => w.id !== ws.id));
      if (workspaceId === ws.id) {
        const remaining = workspaces.filter((w) => w.id !== ws.id);
        if (remaining.length) {
          router.push(`/app/${remaining[0].id}`);
        } else {
          router.push("/app");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete workspace");
    }
  }

  function openRename(ws: Workspace) {
    setError(null);
    setRenameWorkspace(ws);
    setNewName(ws.name);
    setRenameOpen(true);
  }

  function openSettings(ws: Workspace) {
    setError(null);
    setSettingsWorkspace(ws);
    setSettingsOpen(true);
  }

  async function handleReimport(ws: Workspace) {
    if (!ws.github_repo_url) return;
    if (!confirm("Re-import from GitHub will overwrite all workspace contents. Local changes will be lost. Continue?")) return;
    setError(null);
    setReimporting(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/reimport-github`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-import failed");
      setSettingsOpen(false);
      setSettingsWorkspace(null);
      window.dispatchEvent(new CustomEvent("refresh-file-tree"));
      if (typeof data.filesImported === "number") {
        setCreateSuccess(`Re-imported ${data.filesImported} file(s) from GitHub.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-import failed");
    } finally {
      setReimporting(false);
    }
  }

  async function handlePull(ws: Workspace) {
    setError(null);
    setPulling(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/pull`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Pull failed");
      setGitStatus(null);
      window.dispatchEvent(new CustomEvent("refresh-file-tree"));
      if (typeof data.filesImported === "number") {
        setCreateSuccess(`Pulled ${data.filesImported} file(s) from GitHub.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pull failed");
    } finally {
      setPulling(false);
    }
  }

  async function loadGitStatus(ws: Workspace) {
    setGitStatusLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/git/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load status");
      setGitStatus({ currentBranch: data.currentBranch ?? "main", entries: data.entries ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load status");
      setGitStatus(null);
    } finally {
      setGitStatusLoading(false);
    }
  }

  async function handleCreateBranch(ws: Workspace) {
    const name = newBranchName.trim();
    if (!name) return;
    setError(null);
    setCreateBranchLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/git/create-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchName: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Create branch failed");
      setNewBranchName("");
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === ws.id ? { ...w, github_current_branch: name } : w))
      );
      if (settingsWorkspace?.id === ws.id) setSettingsWorkspace({ ...ws, github_current_branch: name });
      setGitStatus((s) => (s ? { ...s, currentBranch: name } : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create branch failed");
    } finally {
      setCreateBranchLoading(false);
    }
  }

  async function handleCommitPush(ws: Workspace) {
    setError(null);
    setLastPrUrl(null);
    setCommitPushLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/git/commit-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: commitMessage.trim() || "Update from AIForge" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Commit or push failed");
      setCommitMessage("");
      if (data.prUrl) setLastPrUrl(data.prUrl);
      loadGitStatus(ws);
      setCommitPushConfirmOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit or push failed");
    } finally {
      setCommitPushLoading(false);
    }
  }

  function openCommitPushConfirm() {
    setError(null);
    setCommitPushConfirmOpen(true);
  }

  if (loading) {
    return (
      <div className="px-2 py-2 text-sm text-muted-foreground">
        Loading workspaces…
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="px-2 text-xs font-medium text-muted-foreground">
        Workspaces
      </p>
      <div className="space-y-0.5">
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm border-l-2 ${
              workspaceId === ws.id
                ? "bg-accent text-accent-foreground border-l-primary"
                : "border-l-transparent hover:bg-accent/50"
            }`}
          >
            <button
              type="button"
              className="flex flex-1 items-center gap-2 truncate text-left"
              onClick={async () => {
                try {
                  await fetch(`/api/workspaces/${ws.id}/set-active`, { method: "POST" });
                } catch {
                  // non-blocking
                }
                router.push(`/app/${ws.id}`);
              }}
            >
              <FolderOpen className="h-4 w-4 shrink-0" />
              {ws.github_repo_url && (
                <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" title="Linked to GitHub" />
              )}
              <span className="truncate">{ws.name}</span>
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
                <DropdownMenuItem onClick={() => openSettings(ws)}>
                  <Settings className="mr-2 h-4 w-4" />
                  Workspace settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openRename(ws)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/workspaces/${ws.id}/export`);
                      if (!res.ok) {
                        const error = await res.json();
                        alert(error.error || "Export failed");
                        return;
                      }
                      const blob = await res.blob();
                      const url = window.URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `${ws.name || "workspace"}-${ws.id.substring(0, 8)}.zip`;
                      document.body.appendChild(a);
                      a.click();
                      window.URL.revokeObjectURL(url);
                      document.body.removeChild(a);
                    } catch (e) {
                      alert(e instanceof Error ? e.message : "Export failed");
                    }
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export as ZIP
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => handleDelete(ws)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
      {createSuccess && (
        <p className="px-2 text-xs text-green-600 dark:text-green-400">{createSuccess}</p>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => {
              setError(null);
              setCreateSuccess(null);
              setCreateName("");
              setCreateRepoUrl("");
              setCreateBranch("main");
              setCreateMode("empty");
              setSelectedMyRepo(null);
            }}
          >
            <Plus className="h-4 w-4" />
            Create workspace
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Create a workspace from scratch, import a public repo by URL, or pick one of your GitHub repos (optional).
            </p>
            <div className="space-y-2">
              <Label className="text-muted-foreground">How do you want to start?</Label>
              <div className="grid gap-2">
                <button
                  type="button"
                  className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors ${
                    createMode === "empty"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                  onClick={() => setCreateMode("empty")}
                >
                  <span className="font-medium">Empty workspace</span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    Start from scratch — no GitHub or repo needed
                  </span>
                </button>
                <button
                  type="button"
                  className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors ${
                    createMode === "github"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                  onClick={() => setCreateMode("github")}
                >
                  <span className="font-medium">Import from public GitHub URL</span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    Paste any public repo URL — no GitHub account needed
                  </span>
                </button>
                <button
                  type="button"
                  className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors ${
                    createMode === "myRepos"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  }`}
                  onClick={() => {
                    setCreateMode("myRepos");
                    setError(null);
                    loadMyRepos();
                  }}
                >
                  <span className="font-medium">Select from my GitHub repos</span>
                  <span className="text-xs text-muted-foreground mt-0.5">
                    Connect GitHub in Settings first; includes private repos
                  </span>
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-name">Workspace name</Label>
              <Input
                id="create-name"
                placeholder={createMode !== "empty" ? "e.g. my-repo" : "Untitled Workspace"}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            {createMode === "github" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="create-repo-url">Repo URL</Label>
                  <Input
                    id="create-repo-url"
                    placeholder="https://github.com/user/repo"
                    value={createRepoUrl}
                    onChange={(e) => setCreateRepoUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="create-branch">Branch (optional)</Label>
                  <Input
                    id="create-branch"
                    placeholder="main"
                    value={createBranch}
                    onChange={(e) => setCreateBranch(e.target.value)}
                  />
                </div>
              </>
            )}
            {createMode === "myRepos" && (
              <div className="space-y-2">
                <Label>Select a repo</Label>
                {myReposLoading ? (
                  <p className="text-sm text-muted-foreground">Loading repos…</p>
                ) : myRepos.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No repos found. Connect GitHub in Settings first.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto rounded-md border border-border p-1 space-y-0.5">
                    {myRepos.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className={`w-full text-left rounded px-2 py-1.5 text-sm truncate ${
                          selectedMyRepo?.id === r.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                        onClick={() => setSelectedMyRepo(r)}
                      >
                        {r.fullName}
                        {r.private ? " (private)" : ""}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
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
              onClick={handleCreate}
              disabled={
                submitting ||
                (createMode === "github" && !createRepoUrl.trim()) ||
                (createMode === "myRepos" && !selectedMyRepo)
              }
            >
              {submitting
                ? createMode !== "empty"
                  ? "Importing…"
                  : "Creating…"
                : createMode === "github"
                  ? "Import"
                  : createMode === "myRepos"
                    ? "Create workspace"
                    : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rename-name">Name</Label>
              <Input
                id="rename-name"
                placeholder="Untitled Workspace"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
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
            <Button onClick={handleRename} disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={(open) => { setSettingsOpen(open); if (!open) { setGitStatus(null); setLastPrUrl(null); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Workspace settings</DialogTitle>
          </DialogHeader>
          {settingsWorkspace && (
            <div className="space-y-4 py-4">
              <div className="space-y-1">
                <Label className="text-muted-foreground">Name</Label>
                <p className="text-sm font-medium">{settingsWorkspace.name}</p>
                <p className="text-xs text-muted-foreground">Use Rename from the menu to change.</p>
              </div>
              <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Safe edit mode (recommended)</Label>
                  <p className="text-xs text-muted-foreground">
                    Limits large or risky changes and can block pushing when tests are failing.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settingsWorkspace.safe_edit_mode !== false}
                  disabled={savingSafeEdit}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 ${
                    settingsWorkspace.safe_edit_mode !== false ? "bg-primary" : "bg-muted"
                  }`}
                  onClick={async () => {
                    const next = !(settingsWorkspace.safe_edit_mode !== false);
                    setSavingSafeEdit(true);
                    setError(null);
                    try {
                      const res = await fetch(`/api/workspaces/${settingsWorkspace.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ safe_edit_mode: next }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || "Failed to update");
                      setSettingsWorkspace((w) => (w ? { ...w, safe_edit_mode: next } : null));
                      setWorkspaces((prev) =>
                        prev.map((w) => (w.id === settingsWorkspace.id ? { ...w, safe_edit_mode: next } : w))
                      );
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "Failed to update");
                    } finally {
                      setSavingSafeEdit(false);
                    }
                  }}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                      settingsWorkspace.safe_edit_mode !== false ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
              {settingsWorkspace.github_repo_url ? (
                <>
                  <div className="space-y-1">
                    <Label className="text-muted-foreground">GitHub repo</Label>
                    <p className="text-sm font-mono break-all">{settingsWorkspace.github_repo_url}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-muted-foreground">Current branch</Label>
                    <p className="text-sm font-mono">{settingsWorkspace.github_current_branch ?? settingsWorkspace.github_default_branch ?? "main"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => handlePull(settingsWorkspace)}
                      disabled={pulling}
                    >
                      <GitPullRequest className="h-4 w-4" />
                      {pulling ? "Pulling…" : "Pull latest from origin"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2"
                      onClick={() => handleReimport(settingsWorkspace)}
                      disabled={reimporting}
                    >
                      {reimporting ? "Re-importing…" : "Re-import (overwrite)"}
                    </Button>
                  </div>
                  <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                    Re-import overwrites all workspace files with the current state of the repo. Local changes will be lost.
                  </div>
                  <div className="border-t border-border pt-4 space-y-3">
                    <Label className="text-base font-medium flex items-center gap-2">
                      <GitBranch className="h-4 w-4" />
                      Git
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        placeholder="New branch name (e.g. feature/xyz)"
                        value={newBranchName}
                        onChange={(e) => setNewBranchName(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCreateBranch(settingsWorkspace)}
                        disabled={createBranchLoading || !newBranchName.trim()}
                      >
                        {createBranchLoading ? "Creating…" : "Create branch"}
                      </Button>
                    </div>
                    <div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mb-2"
                        onClick={() => loadGitStatus(settingsWorkspace)}
                        disabled={gitStatusLoading}
                      >
                        {gitStatusLoading ? "Loading…" : "Refresh status"}
                      </Button>
                      {gitStatus && (
                        <div className="max-h-32 overflow-y-auto rounded border border-border p-2 text-xs font-mono space-y-0.5">
                          {gitStatus.entries.length === 0 ? (
                            <p className="text-muted-foreground">No changes</p>
                          ) : (
                            gitStatus.entries.map((e, i) => (
                              <div key={i} className="truncate">
                                <span className="text-muted-foreground mr-1">{e.status}</span>
                                {e.path}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Every write goes through a confirmation dialog first, and the app never modifies your default branch without your explicit approval.
                    </p>
                    {settingsWorkspace.safe_edit_mode !== false && testsFailingForWorkspace === settingsWorkspace.id && (
                      <p className="text-sm text-amber-800 dark:text-amber-200">
                        Safe edit mode is on and tests are failing. Fix or rerun tests before pushing.
                      </p>
                    )}
                    <div className="flex gap-2">
                      <Input
                        placeholder="Commit message"
                        value={commitMessage}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        size="sm"
                        onClick={openCommitPushConfirm}
                        disabled={
                          commitPushLoading ||
                          (settingsWorkspace.safe_edit_mode !== false && testsFailingForWorkspace === settingsWorkspace.id)
                        }
                      >
                        {commitPushLoading ? "Pushing…" : "Commit & push"}
                      </Button>
                    </div>
                    <Dialog open={commitPushConfirmOpen} onOpenChange={setCommitPushConfirmOpen}>
                      <DialogContent aria-describedby="commit-push-confirm-desc">
                        <DialogHeader>
                          <DialogTitle>Confirm commit & push</DialogTitle>
                        </DialogHeader>
                        <div id="commit-push-confirm-desc" className="space-y-3 py-2">
                          <p className="text-sm text-muted-foreground">
                            This will sync your workspace files, create a commit with your message, and push it to branch{" "}
                            <span className="font-mono">{settingsWorkspace?.github_current_branch ?? settingsWorkspace?.github_default_branch ?? "main"}</span>
                            {" "}on{" "}
                            <span className="font-mono">{settingsWorkspace?.github_owner && settingsWorkspace?.github_repo ? `${settingsWorkspace.github_owner}/${settingsWorkspace.github_repo}` : "this repo"}</span>
                            . The remote repo on GitHub will be updated, and others with access will see these changes.
                          </p>
                          <p className="text-sm text-amber-800 dark:text-amber-200">
                            We do not modify the default branch directly; you can review everything on GitHub before merging.
                          </p>
                        </div>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => setCommitPushConfirmOpen(false)}
                            disabled={commitPushLoading}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => settingsWorkspace && handleCommitPush(settingsWorkspace)}
                            disabled={commitPushLoading}
                          >
                            {commitPushLoading ? "Pushing…" : "Commit & push"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    {lastPrUrl && (
                      <a
                        href={lastPrUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                      >
                        Open Pull Request on GitHub
                      </a>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">This workspace is not linked to a GitHub repo. Create a new workspace with &quot;Import from GitHub&quot; to link one.</p>
              )}
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
