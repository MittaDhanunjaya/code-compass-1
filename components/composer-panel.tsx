"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2, Wand2, Check, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/lib/editor-context";
import { PROVIDERS, type ProviderId } from "@/lib/llm/providers";
import type { FileEditStep } from "@/lib/agent/types";
import type { ComposerScope } from "@/lib/composer/types";
import { SAFE_EDIT_MAX_FILES } from "@/lib/protected-paths";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

const WORKSPACE_FILE_CAP = 20;

type StepWithContent = {
  path: string;
  originalContent: string;
  newContent: string;
  oldContent?: string;
  description?: string;
};

type ComposerPanelProps = {
  workspaceId: string | null;
};

function getLanguage(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    py: "python",
    css: "css",
    html: "html",
  };
  return map[ext] ?? "plaintext";
}

export function ComposerPanel({ workspaceId }: ComposerPanelProps) {
  const { activeTab: currentFilePath, getTab, updateContent, openFile } = useEditor();
  const [instruction, setInstruction] = useState("");
  const [scope, setScope] = useState<ComposerScope>("current_file");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepsWithContent, setStepsWithContent] = useState<StepWithContent[]>([]);
  const [planSummary, setPlanSummary] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [largeFileConfirmOpen, setLargeFileConfirmOpen] = useState(false);
  const [largeFileCount, setLargeFileCount] = useState(0);
  const [pendingStepsForApply, setPendingStepsForApply] = useState<FileEditStep[] | null>(null);
  const [protectedConfirmOpen, setProtectedConfirmOpen] = useState(false);
  const [protectedPathsList, setProtectedPathsList] = useState<string[]>([]);
  const [pendingStepsForProtected, setPendingStepsForProtected] = useState<FileEditStep[] | null>(null);

  // Reuse Chat provider/model from localStorage
  const getStoredProvider = (): ProviderId => {
    if (typeof window === "undefined") return "openrouter";
    const key = workspaceId ? `chat-provider-${workspaceId}` : "chat-provider-default";
    const stored = localStorage.getItem(key);
    return (stored && PROVIDERS.includes(stored as ProviderId)) ? (stored as ProviderId) : "openrouter";
  };
  const getStoredModel = (): string => {
    if (typeof window === "undefined") return "openrouter/free";
    const key = workspaceId ? `chat-model-${workspaceId}` : "chat-model-default";
    const m = localStorage.getItem(key) || "openrouter/free";
    if (m === "deepseek/deepseek-coder:free" || m === "deepseek/deepseek-r1:free") return "openrouter/free";
    return m;
  };
  const provider = getStoredProvider();
  const model = getStoredModel();

  const generateEdits = useCallback(async () => {
    if (!instruction.trim() || !workspaceId) return;
    if (scope === "current_file" && !currentFilePath) {
      setError("Open a file for 'Current file only' scope.");
      return;
    }
    setError(null);
    setLoading(true);
    setStepsWithContent([]);
    setPlanSummary(null);
    try {
      const fileListRes = await fetch(`/api/workspaces/${workspaceId}/files`);
      const fileListData = await fileListRes.json();
      const paths: string[] = Array.isArray(fileListData) ? fileListData.map((f: { path: string }) => f.path) : [];
      const fileContents: Record<string, string> = {};
      for (const path of paths) {
        const tab = getTab(path);
        if (tab) fileContents[path] = tab.content;
      }
      const res = await fetch("/api/composer/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          instruction: instruction.trim(),
          scope,
          currentFilePath: currentFilePath ?? undefined,
          provider,
          model: provider === "openrouter" ? model : undefined,
          fileContents: Object.keys(fileContents).length ? fileContents : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Plan failed");
      const steps = data.stepsWithContent ?? [];
      setStepsWithContent(steps);
      setPlanSummary(data.plan?.summary ?? null);
      setSelectedPaths(new Set(steps.map((s: StepWithContent) => s.path)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan failed");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, instruction, scope, currentFilePath, provider, model, getTab]);

  const executeApply = useCallback(
    async (steps: FileEditStep[], confirmedProtectedPaths?: string[]) => {
      if (!workspaceId) return;
      setApplying(true);
      setError(null);
      try {
        const res = await fetch("/api/composer/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            steps,
            confirmedProtectedPaths: confirmedProtectedPaths ?? undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Apply failed");
        if (data.needProtectedConfirmation && Array.isArray(data.protectedPaths)) {
          setProtectedPathsList(data.protectedPaths);
          setPendingStepsForProtected(steps);
          setProtectedConfirmOpen(true);
          setApplying(false);
          return;
        }
        for (const path of data.filesEdited ?? []) {
          const fileRes = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`);
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            const content = fileData.content ?? "";
            const tab = getTab(path);
            if (tab) updateContent(path, content);
            else openFile(path, content);
          }
        }
        setStepsWithContent([]);
        setPlanSummary(null);
        setSelectedPaths(new Set());
        window.dispatchEvent(new CustomEvent("refresh-file-tree"));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Apply failed");
      } finally {
        setApplying(false);
      }
    },
    [workspaceId, getTab, updateContent, openFile]
  );

  const applySelected = useCallback(async () => {
    if (!workspaceId || stepsWithContent.length === 0) return;
    const toApply = stepsWithContent.filter((s) => selectedPaths.has(s.path));
    if (toApply.length === 0) return;
    const steps: FileEditStep[] = toApply.map((s) => ({
      type: "file_edit" as const,
      path: s.path,
      newContent: s.newContent,
      oldContent: s.oldContent,
      description: s.description,
    }));
    try {
      const wsRes = await fetch(`/api/workspaces/${workspaceId}`);
      const ws = await wsRes.json();
      const safeEditMode = ws.safe_edit_mode !== false;
      if (safeEditMode && toApply.length > SAFE_EDIT_MAX_FILES) {
        setLargeFileCount(toApply.length);
        setPendingStepsForApply(steps);
        setLargeFileConfirmOpen(true);
        return;
      }
      await executeApply(steps);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    }
  }, [workspaceId, stepsWithContent, selectedPaths, executeApply]);

  const confirmLargeFileApply = useCallback(() => {
    if (pendingStepsForApply) {
      executeApply(pendingStepsForApply);
      setPendingStepsForApply(null);
      setLargeFileConfirmOpen(false);
    }
  }, [pendingStepsForApply, executeApply]);

  const confirmProtectedApply = useCallback(() => {
    if (pendingStepsForProtected) {
      executeApply(pendingStepsForProtected, protectedPathsList);
      setPendingStepsForProtected(null);
      setProtectedPathsList([]);
      setProtectedConfirmOpen(false);
    }
  }, [pendingStepsForProtected, protectedPathsList, executeApply]);

  const togglePath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedPaths.size === stepsWithContent.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(stepsWithContent.map((s) => s.path)));
    }
  };

  if (!workspaceId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-sm text-muted-foreground">
        <p>Open a workspace to use Composer</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
        <label className="text-xs font-medium text-muted-foreground">Edit instruction</label>
        <Textarea
          placeholder="e.g. Add logging to all API handlers"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          className="min-h-[72px] resize-none text-sm"
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Scope</span>
          <div className="flex gap-1 rounded-lg border border-border p-1">
            <button
              type="button"
              onClick={() => setScope("current_file")}
              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                scope === "current_file" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              Current file only
            </button>
            <button
              type="button"
              onClick={() => setScope("current_folder")}
              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                scope === "current_folder" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              Current folder
            </button>
            <button
              type="button"
              onClick={() => setScope("workspace")}
              className={`flex-1 rounded px-2 py-1.5 text-xs font-medium ${
                scope === "workspace" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              Workspace (≤{WORKSPACE_FILE_CAP} files)
            </button>
          </div>
        </div>
        <Button
          className="w-full gap-2"
          onClick={generateEdits}
          disabled={loading || !instruction.trim() || (scope !== "workspace" && !currentFilePath)}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Generate edits
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="shrink-0 px-3 py-2">
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {planSummary && (
          <p className="text-xs text-muted-foreground border-b border-border pb-2">{planSummary}</p>
        )}
        {stepsWithContent.length > 0 && (
          <>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={selectAll}>
                {selectedPaths.size === stepsWithContent.length ? "Deselect all" : "Select all"}
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={applySelected}
                disabled={applying || selectedPaths.size === 0}
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Apply selected ({selectedPaths.size})
                  </>
                )}
              </Button>
            </div>
            <div className="space-y-1">
              {stepsWithContent.map((step) => (
                <div
                  key={step.path}
                  className="rounded-lg border border-border bg-muted/20 overflow-hidden"
                >
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
                    onClick={() => setExpandedPath((p) => (p === step.path ? null : step.path))}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(step.path)}
                      onChange={(e) => {
                        e.stopPropagation();
                        togglePath(step.path);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border-border"
                    />
                    {expandedPath === step.path ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="truncate">{step.path}</span>
                  </button>
                  {expandedPath === step.path && (
                    <div className="border-t border-border h-48">
                      <MonacoDiffEditor
                        height="100%"
                        language={getLanguage(step.path)}
                        original={step.originalContent}
                        modified={step.newContent}
                        theme="vs-dark"
                        options={{
                          readOnly: true,
                          renderSideBySide: true,
                          minimap: { enabled: false },
                          lineNumbers: "on",
                          fontSize: 12,
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
        {!loading && stepsWithContent.length === 0 && (
          <p className="text-xs text-muted-foreground py-4">
            Enter an instruction and click Generate edits. Scope limits which files can be changed.
          </p>
        )}
      </div>

      <Dialog open={largeFileConfirmOpen} onOpenChange={(open) => { if (!open) { setLargeFileConfirmOpen(false); setPendingStepsForApply(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm large change</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This action will change {largeFileCount} file(s) in this workspace. In Safe edit mode we recommend reviewing large changes carefully. Continue?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setLargeFileConfirmOpen(false); setPendingStepsForApply(null); }}>
              Cancel
            </Button>
            <Button onClick={confirmLargeFileApply} disabled={applying}>
              {applying ? "Applying…" : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={protectedConfirmOpen} onOpenChange={(open) => { if (!open) { setProtectedConfirmOpen(false); setPendingStepsForProtected(null); setProtectedPathsList([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Protected files</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            You&apos;re about to change protected files: {protectedPathsList.join(", ")}. These often contain secrets or important configuration. Are you sure you want the AI to edit them?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setProtectedConfirmOpen(false); setPendingStepsForProtected(null); setProtectedPathsList([]); setError("Protected file changes were skipped."); }}>
              Cancel
            </Button>
            <Button onClick={confirmProtectedApply} disabled={applying}>
              {applying ? "Applying…" : "Allow this time"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
