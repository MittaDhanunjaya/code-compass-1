"use client";

import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { GitCompare, Save, Terminal, ArrowRight, List, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TabBar } from "@/components/tab-bar";
import { TerminalPanel } from "@/components/terminal-panel";
import { useEditor } from "@/lib/editor-context";
import { ErrorWithAction } from "@/components/error-with-action";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.default),
  { ssr: false }
);

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

/** Debounce delay (ms) before requesting Tab completion (150–200ms for snappier feel). */
const TAB_COMPLETION_DEBOUNCE_MS = 150;
/** Client-side completion cache TTL (ms) for instant reuse when typing. */
const TAB_COMPLETION_CLIENT_CACHE_MS = 6000;
const TAB_COMPLETION_PREFIX_TAIL_LEN = 280;
/** Debounce (ms) before requesting live lint. */
const LINT_DEBOUNCE_MS = 700;

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", py: "python", go: "go", rs: "rust", css: "css", html: "html",
  };
  return map[ext] ?? "plaintext";
}

const LSP_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"]);
function isLspSupportedPath(path: string): boolean {
  return LSP_EXTENSIONS.has((path.split(".").pop() ?? "").toLowerCase());
}

type RenameEdit = { filePath: string; startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string };

function lineColToOffset(content: string, line1: number, col1: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let i = 0; i < line1 - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  const colIndex = Math.min(col1 - 1, lines[line1 - 1]?.length ?? 0);
  return offset + colIndex;
}

function applyRenameEditsToContent(content: string, edits: RenameEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.startLine !== b.startLine ? b.startLine - a.startLine : b.startColumn - a.startColumn);
  let result = content;
  for (const e of sorted) {
    const start = lineColToOffset(result, e.startLine, e.startColumn);
    const end = lineColToOffset(result, e.endLine, e.endColumn);
    result = result.slice(0, start) + e.newText + result.slice(end);
  }
  return result;
}

export function EditorArea() {
  const {
    activeTab,
    updateContent,
    saveFile,
    getTab,
    setSelection,
    workspaceId,
    openFile,
    setActiveTab,
    pendingCmdKSuggestion,
    setPendingCmdKSuggestion,
    applyExternalEdits,
  } = useEditor();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const TERMINAL_VISIBLE_KEY = "aiforge-terminal-visible";
  const [terminalVisible, setTerminalVisibleState] = useState(false);
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.sessionStorage.getItem(TERMINAL_VISIBLE_KEY) === "1") {
        setTerminalVisibleState(true);
      }
    } catch {
      // ignore
    }
  }, []);
  const setTerminalVisible = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    setTerminalVisibleState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      try {
        window.sessionStorage.setItem(TERMINAL_VISIBLE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const showTerminal = () => setTerminalVisible(true);
    window.addEventListener("aiforge-show-terminal", showTerminal);
    return () => window.removeEventListener("aiforge-show-terminal", showTerminal);
  }, [setTerminalVisible]);

  const [tabCompletionPending, setTabCompletionPending] = useState(false);
  const [referencesDialogOpen, setReferencesDialogOpen] = useState(false);
  const [referencesList, setReferencesList] = useState<{ filePath: string; line: number; context?: string }[]>([]);
  const [referencesSymbol, setReferencesSymbol] = useState<string | null>(null);
  const [referencesCurrentFileOnly, setReferencesCurrentFileOnly] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameInitialName, setRenameInitialName] = useState("");
  const [renameNewName, setRenameNewName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameApplying, setRenameApplying] = useState(false);
  const selectionDisposable = useRef<{ dispose: () => void } | null>(null);
  const tabCompletionDisposable = useRef<{ dispose: () => void } | null>(null);
  const tabCompletionContextRef = useRef({ workspaceId: null as string | null, filePath: null as string | null, language: "plaintext" });
  const setTabCompletionPendingRef = useRef(setTabCompletionPending);
  setTabCompletionPendingRef.current = setTabCompletionPending;
  const tabCompletionClientCacheRef = useRef<Map<string, { completion: string; ts: number }>>(new Map());
  const TAB_CACHE_MAX = 80;
  const lintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lintContextRef = useRef({ workspaceId: null as string | null, filePath: null as string | null });
  const lintDisposable = useRef<{ dispose: () => void } | null>(null);
  const [lintError, setLintError] = useState<string | null>(null);
  const setLintErrorRef = useRef(setLintError);
  setLintErrorRef.current = setLintError;
  type LintDiag = { line: number; column: number; endLine?: number; endColumn?: number; message: string; severity: string; fix?: { range: { start: number; end: number }; text: string } };
  const lastLintDiagnosticsRef = useRef<LintDiag[]>([]);
  const pendingCmdKSuggestionRef = useRef(pendingCmdKSuggestion);
  pendingCmdKSuggestionRef.current = pendingCmdKSuggestion;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const cmdKGhostDecorationIdsRef = useRef<string[]>([]);
  const pendingGoToLineRef = useRef<{ path: string; line: number } | null>(null);
  const goToDefinitionRef = useRef<() => void>(() => {});
  const findReferencesRef = useRef<() => void>(() => {});
  const renameSymbolRef = useRef<() => void>(() => {});

  const tab = activeTab ? getTab(activeTab) : null;

  useEffect(() => {
    tabCompletionContextRef.current = {
      workspaceId,
      filePath: activeTab ?? null,
      language: tab ? getLanguageFromPath(tab.path) : "plaintext",
    };
    lintContextRef.current = { workspaceId: workspaceId ?? null, filePath: activeTab ?? null };
  }, [workspaceId, activeTab, tab?.path]);

  // Cmd+K ghost text: show suggestion as "after" decoration; clear when dismissed or path changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const p = pendingCmdKSuggestion;
    const ids = cmdKGhostDecorationIdsRef.current;
    if (!p || activeTab !== p.path) {
      if (ids.length > 0) {
        editor.deltaDecorations(ids, []);
        cmdKGhostDecorationIdsRef.current = [];
      }
      return;
    }
    const r = p.range;
    const newDecs = [
      {
        range: { startLineNumber: r.startLineNumber, startColumn: r.startColumn, endLineNumber: r.endLineNumber, endColumn: r.endColumn },
        options: {
          after: { content: p.newContent, inlineClassName: "cmd-k-ghost" },
        },
      },
    ];
    const newIds = editor.deltaDecorations(ids, newDecs);
    cmdKGhostDecorationIdsRef.current = newIds;
  }, [pendingCmdKSuggestion, activeTab]);

  useEffect(() => {
    const onCmdKInlineSuggestion = (e: CustomEvent<{ path: string; newContent: string }>) => {
      const { path, newContent } = e.detail ?? {};
      if (!path || !activeTab || path !== activeTab || !editorRef.current) return;
      const sel = editorRef.current.getSelection();
      if (!sel) return;
      setPendingCmdKSuggestion({
        path,
        newContent,
        range: {
          startLineNumber: sel.startLineNumber,
          startColumn: sel.startColumn,
          endLineNumber: sel.endLineNumber,
          endColumn: sel.endColumn,
        },
      });
    };
    window.addEventListener("cmd-k-inline-suggestion", onCmdKInlineSuggestion as EventListener);
    return () => window.removeEventListener("cmd-k-inline-suggestion", onCmdKInlineSuggestion as EventListener);
  }, [activeTab, setPendingCmdKSuggestion]);

  useEffect(() => {
    return () => {
      selectionDisposable.current?.dispose();
      selectionDisposable.current = null;
      tabCompletionDisposable.current?.dispose();
      tabCompletionDisposable.current = null;
      if (lintTimeoutRef.current) {
        clearTimeout(lintTimeoutRef.current);
        lintTimeoutRef.current = null;
      }
      lintDisposable.current?.dispose();
      lintDisposable.current = null;
    };
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    setSaveError(null);
    setSaving(true);
    try {
      await saveFile(activeTab);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [activeTab, saveFile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        if (tab?.dirty) setDiffOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        setTerminalVisible((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, tab?.dirty]);

  // When Agent panel requests diff for a path, open diff once that tab is active
  const pendingDiffPathRef = useRef<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (path) pendingDiffPathRef.current = path;
    };
    window.addEventListener("agent-request-diff", handler);
    return () => window.removeEventListener("agent-request-diff", handler);
  }, []);
  useEffect(() => {
    const pending = pendingDiffPathRef.current;
    if (pending && activeTab === pending) {
      pendingDiffPathRef.current = null;
      setDiffOpen(true);
    }
  }, [activeTab]);

  // Apply "go to line" when we've switched to the target file
  useEffect(() => {
    const pending = pendingGoToLineRef.current;
    if (!pending || activeTab !== pending.path || !editorRef.current) return;
    pendingGoToLineRef.current = null;
    const editor = editorRef.current;
    editor.setPosition({ lineNumber: pending.line, column: 1 });
    editor.revealLineInCenter(pending.line);
    editor.focus();
  }, [activeTab]);

  const fetchLocateData = useCallback(
    async (path: string, line: number, character: number): Promise<{
      symbol: string | null;
      definitions: { filePath: string; line: number }[];
      references: { filePath: string; line: number; context?: string }[];
      currentFileOnly?: boolean;
    } | null> => {
      if (!workspaceId) return null;
      try {
        if (isLspSupportedPath(path)) {
          const res = await fetch(`/api/workspaces/${workspaceId}/lsp/locate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, line, character }),
          });
          if (res.ok) {
            const data = await res.json();
            return data;
          }
        }
        const res = await fetch(
          `/api/workspaces/${workspaceId}/symbols/locate?filePath=${encodeURIComponent(path)}&line=${line}&character=${character}`
        );
        const data = await res.json();
        return data;
      } catch {
        return null;
      }
    },
    [workspaceId]
  );

  const goToDefinition = useCallback(async () => {
    if (!workspaceId || !activeTab || !editorRef.current) return;
    const pos = editorRef.current.getPosition();
    if (!pos) return;
    try {
      const data = await fetchLocateData(activeTab, pos.lineNumber, pos.column);
      if (!data) return;
      const def = data.definitions?.[0];
      if (!def) return;
      if (def.filePath === activeTab) {
        editorRef.current.setPosition({ lineNumber: def.line, column: 1 });
        editorRef.current.revealLineInCenter(def.line);
        return;
      }
      const tab = getTab(def.filePath);
      const content = tab?.content;
      if (content !== undefined) {
        openFile(def.filePath, content);
        setActiveTab(def.filePath);
        pendingGoToLineRef.current = { path: def.filePath, line: def.line };
      } else {
        const fileRes = await fetch(
          `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(def.filePath)}`
        );
        if (!fileRes.ok) return;
        const fileData = await fileRes.json();
        openFile(def.filePath, fileData.content ?? "");
        setActiveTab(def.filePath);
        pendingGoToLineRef.current = { path: def.filePath, line: def.line };
      }
    } catch {
      // ignore
    }
  }, [workspaceId, activeTab, getTab, openFile, setActiveTab, fetchLocateData]);

  const findReferences = useCallback(async () => {
    if (!workspaceId || !activeTab || !editorRef.current) return;
    const pos = editorRef.current.getPosition();
    if (!pos) return;
    try {
      const data = await fetchLocateData(activeTab, pos.lineNumber, pos.column);
      if (!data) return;
      const refs = [
        ...(data.definitions ?? []).map((d: { filePath: string; line: number }) => ({ ...d, context: undefined })),
        ...(data.references ?? []),
      ];
      setReferencesSymbol(data.symbol ?? null);
      setReferencesList(refs);
      setReferencesCurrentFileOnly(data.currentFileOnly === true);
      setReferencesDialogOpen(true);
    } catch {
      // ignore
    }
  }, [workspaceId, activeTab, fetchLocateData]);

  const openReference = useCallback(
    async (item: { filePath: string; line: number }) => {
      setReferencesDialogOpen(false);
      if (item.filePath === activeTab) {
        editorRef.current?.setPosition({ lineNumber: item.line, column: 1 });
        editorRef.current?.revealLineInCenter(item.line);
        return;
      }
      const tab = getTab(item.filePath);
      const content = tab?.content;
      if (content !== undefined) {
        openFile(item.filePath, content);
        setActiveTab(item.filePath);
        pendingGoToLineRef.current = { path: item.filePath, line: item.line };
      } else {
        const fileRes = await fetch(
          `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(item.filePath)}`
        );
        if (!fileRes.ok) return;
        const fileData = await fileRes.json();
        openFile(item.filePath, fileData.content ?? "");
        setActiveTab(item.filePath);
        pendingGoToLineRef.current = { path: item.filePath, line: item.line };
      }
    },
    [activeTab, getTab, openFile, setActiveTab, workspaceId]
  );

  const openRenameDialog = useCallback(() => {
    if (!editorRef.current || !activeTab) return;
    const pos = editorRef.current.getPosition();
    const model = editorRef.current.getModel();
    if (!pos || !model) return;
    if (!isLspSupportedPath(activeTab)) return;
    const word = model.getWordAtPosition(pos);
    const name = word?.word ?? "";
    if (!name) return;
    setRenameInitialName(name);
    setRenameNewName(name);
    setRenameError(null);
    setRenameDialogOpen(true);
  }, [activeTab]);

  const performRename = useCallback(async () => {
    const newName = renameNewName.trim();
    if (!workspaceId || !activeTab || !newName || renameApplying) return;
    const pos = editorRef.current?.getPosition();
    if (!pos) return;
    setRenameError(null);
    setRenameApplying(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/lsp/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activeTab, line: pos.lineNumber, character: pos.column, newName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRenameError(data.error || "Rename failed");
        return;
      }
      const edits: RenameEdit[] = Array.isArray(data.edits) ? data.edits : [];
      if (edits.length === 0) {
        setRenameDialogOpen(false);
        return;
      }
      const byPath = new Map<string, RenameEdit[]>();
      for (const e of edits) byPath.set(e.filePath, [...(byPath.get(e.filePath) ?? []), e]);
      const fullEdits: { path: string; content: string }[] = [];
      for (const [filePath, fileEdits] of byPath) {
        const tab = getTab(filePath);
        let content = tab?.content;
        if (content === undefined) {
          const fileRes = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(filePath)}`);
          if (!fileRes.ok) continue;
          const fileData = await fileRes.json();
          content = fileData.content ?? "";
        }
        fullEdits.push({ path: filePath, content: applyRenameEditsToContent(content ?? "", fileEdits) });
      }
      const applyRes = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edits: fullEdits, confirmLargeEdit: true }),
      });
      const applyData = await applyRes.json().catch(() => ({}));
      if (!applyRes.ok && applyData.applied?.length === 0) {
        setRenameError(applyData.error || "Failed to apply rename");
        return;
      }
      applyExternalEdits(fullEdits);
      setRenameDialogOpen(false);
    } finally {
      setRenameApplying(false);
    }
  }, [workspaceId, activeTab, renameNewName, renameApplying, getTab, applyExternalEdits]);

  useEffect(() => {
    goToDefinitionRef.current = goToDefinition;
    findReferencesRef.current = findReferences;
    renameSymbolRef.current = openRenameDialog;
  }, [goToDefinition, findReferences, openRenameDialog]);

  useEffect(() => {
    const onCommand = (ev: Event) => {
      const { commandId } = (ev as CustomEvent<{ commandId: string }>).detail ?? {};
      if (commandId === "goToDefinition") goToDefinitionRef.current?.();
      else if (commandId === "findReferences") findReferencesRef.current?.();
      else if (commandId === "renameSymbol") renameSymbolRef.current?.();
    };
    window.addEventListener("command-palette-run", onCommand);
    return () => window.removeEventListener("command-palette-run", onCommand);
  }, []);

  const getLanguage = (path: string) => {
    const ext = path.split(".").pop() ?? "";
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      json: "json",
      md: "markdown",
      py: "python",
      go: "go",
      rs: "rust",
      css: "css",
      html: "html",
    };
    return map[ext] ?? "plaintext";
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TabBar />
      {tab ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          {lintError && (
            <div className="shrink-0 px-2 py-1 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border-b border-border" title={lintError}>
              Lint unavailable: {lintError.length > 60 ? lintError.slice(0, 57) + "…" : lintError}
            </div>
          )}
          <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-2 py-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              onClick={handleSave}
              disabled={!tab.dirty || saving}
              title={
                saving
                  ? "Saving…"
                  : !tab.dirty
                    ? "No unsaved changes"
                    : "Save file (Ctrl+S)"
              }
            >
              <Save className="h-3.5 w-3.5" />
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              onClick={() => setDiffOpen(true)}
              disabled={!tab.dirty}
              title="Compare with last saved (Ctrl+Shift+D)"
            >
              <GitCompare className="h-3.5 w-3.5" />
              Diff
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              onClick={goToDefinition}
              title="Go to definition (F12)"
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Definition
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              onClick={findReferences}
              title="Find references (Shift+F12)"
            >
              <List className="h-3.5 w-3.5" />
              References
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              onClick={openRenameDialog}
              disabled={!isLspSupportedPath(tab.path)}
              title="Rename symbol (F2)"
            >
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </Button>
            <Button
              variant={terminalVisible ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1"
              onClick={() => setTerminalVisible((prev) => !prev)}
              title="Toggle terminal (Ctrl+`)"
            >
              <Terminal className="h-3.5 w-3.5" />
              Terminal
            </Button>
            {tabCompletionPending && (
              <span className="text-xs text-muted-foreground animate-pulse">Tab completion…</span>
            )}
            {pendingCmdKSuggestion && activeTab === pendingCmdKSuggestion.path && (
              <span className="text-xs text-muted-foreground">
                <kbd className="rounded border border-border bg-muted/50 px-1 font-mono text-[10px]">Tab</kbd> or <kbd className="rounded border border-border bg-muted/50 px-1 font-mono text-[10px]">Cmd+Enter</kbd> to apply, <kbd className="rounded border border-border bg-muted/50 px-1 font-mono text-[10px]">Esc</kbd> to dismiss
              </span>
            )}
            {tab.dirty && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
            {saveError && (
              <ErrorWithAction message={saveError} className="text-xs inline-block" />
            )}
          </div>
          <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
            <DialogContent className="max-h-[90vh] max-w-5xl">
              <DialogHeader>
                <DialogTitle>
                  Diff: {tab.path} (current vs last saved)
                </DialogTitle>
              </DialogHeader>
              <div className="h-[70vh] overflow-hidden rounded border border-border">
                <MonacoDiffEditor
                  height="100%"
                  language={getLanguage(tab.path)}
                  original={tab.savedContent}
                  modified={tab.content}
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: true },
                    lineNumbers: "on",
                  }}
                />
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={referencesDialogOpen} onOpenChange={setReferencesDialogOpen}>
            <DialogContent className="max-w-lg max-h-[70vh] flex flex-col">
              <DialogHeader>
                <DialogTitle>
                  References {referencesSymbol ? `: ${referencesSymbol}` : ""}
                </DialogTitle>
              </DialogHeader>
              {referencesCurrentFileOnly && (
                <p className="text-xs text-muted-foreground">
                  Current file only. Index workspace for cross-file results.
                </p>
              )}
              <div className="flex-1 overflow-y-auto min-h-0 space-y-1">
                {referencesList.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No references found.</p>
                ) : (
                  referencesList.map((item, i) => (
                    <button
                      key={`${item.filePath}:${item.line}:${i}`}
                      type="button"
                      className="w-full text-left rounded px-2 py-1.5 text-sm hover:bg-muted font-mono truncate"
                      onClick={() => openReference(item)}
                    >
                      {item.filePath}:{item.line}
                      {item.context != null && item.context !== "" && (
                        <span className="block text-xs text-muted-foreground mt-0.5 truncate">
                          {item.context.trim().slice(0, 80)}…
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Rename symbol</DialogTitle>
              </DialogHeader>
              <div className="grid gap-2 py-2">
                <Label htmlFor="rename-new-name">New name</Label>
                <Input
                  id="rename-new-name"
                  value={renameNewName}
                  onChange={(e) => setRenameNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") performRename();
                    if (e.key === "Escape") setRenameDialogOpen(false);
                  }}
                  placeholder={renameInitialName}
                  disabled={renameApplying}
                  autoFocus
                  className="font-mono"
                />
                {renameError && (
                  <p className="text-xs text-destructive">{renameError}</p>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" size="sm" onClick={() => setRenameDialogOpen(false)} disabled={renameApplying}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={performRename} disabled={renameApplying || !renameNewName.trim()}>
                    {renameApplying ? "Renaming…" : "Rename"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <div className={`flex-1 overflow-hidden ${terminalVisible ? "flex flex-col" : ""}`}>
            <div className={terminalVisible ? "flex-1 overflow-hidden" : "h-full"}>
              <MonacoEditor
                height="100%"
                language={getLanguage(tab.path)}
                value={tab.content}
                onChange={(value) => updateContent(tab.path, value ?? "")}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  editor.addAction({
                    id: "go-to-definition",
                    label: "Go to Definition",
                    keybindings: [monaco.KeyCode.F12],
                    run: () => goToDefinitionRef.current?.(),
                  });
                  editor.addAction({
                    id: "find-references",
                    label: "Find References",
                    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
                    run: () => findReferencesRef.current?.(),
                  });
                  editor.addAction({
                    id: "rename-symbol",
                    label: "Rename Symbol",
                    keybindings: [monaco.KeyCode.F2],
                    contextMenuGroupId: "1_modification",
                    run: () => renameSymbolRef.current?.(),
                  });
                  editor.addAction({
                    id: "editor-action-explain",
                    label: "Explain",
                    contextMenuGroupId: "ai",
                    run: () => { window.dispatchEvent(new CustomEvent("open-cmd-k", { detail: { action: "explain" } })); },
                  });
                  editor.addAction({
                    id: "editor-action-refactor",
                    label: "Refactor",
                    contextMenuGroupId: "ai",
                    run: () => { window.dispatchEvent(new CustomEvent("open-cmd-k", { detail: { action: "refactor" } })); },
                  });
                  editor.addAction({
                    id: "editor-action-add-tests",
                    label: "Add tests",
                    contextMenuGroupId: "ai",
                    run: () => { window.dispatchEvent(new CustomEvent("open-cmd-k", { detail: { action: "test" } })); },
                  });
                  editor.addAction({
                    id: "editor-action-fix-error",
                    label: "Fix error",
                    contextMenuGroupId: "ai",
                    run: () => { window.dispatchEvent(new CustomEvent("open-cmd-k", { detail: { action: "fix" } })); },
                  });
                  editor.addAction({
                    id: "editor-action-fix-diagnostics",
                    label: "Fix diagnostics in this file",
                    contextMenuGroupId: "ai",
                    run: async () => {
                      const wid = workspaceIdRef.current;
                      const path = activeTabRef.current;
                      const model = editor.getModel();
                      if (!wid || !path || !model) return;
                      try {
                        const res = await fetch(`/api/workspaces/${wid}/lint`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ path, content: model.getValue() }),
                        });
                        const data = await res.json().catch(() => ({}));
                        const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
                        window.dispatchEvent(new CustomEvent("open-cmd-k", {
                          detail: { action: "fix_diagnostics", diagnostics },
                        }));
                      } catch {
                        window.dispatchEvent(new CustomEvent("open-cmd-k", { detail: { action: "fix_diagnostics" } }));
                      }
                    },
                  });
                  const applyCmdKSuggestion = () => {
                    const p = pendingCmdKSuggestionRef.current;
                    const currentPath = activeTabRef.current;
                    if (!p || !currentPath || p.path !== currentPath) return;
                    const model = editor.getModel();
                    if (!model) return;
                    editor.deltaDecorations(cmdKGhostDecorationIdsRef.current, []);
                    cmdKGhostDecorationIdsRef.current = [];
                    editor.executeEdits("cmd-k-apply", [
                      { range: p.range, text: p.newContent, forceMoveMarkers: true },
                    ]);
                    setPendingCmdKSuggestion(null);
                  };
                  editor.addAction({
                    id: "apply-cmd-k-suggestion",
                    label: "Apply Cmd+K suggestion",
                    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
                    run: applyCmdKSuggestion,
                  });
                  editor.addAction({
                    id: "apply-cmd-k-suggestion-tab",
                    label: "Apply Cmd+K suggestion (Tab)",
                    keybindings: [monaco.KeyCode.Tab],
                    run: () => {
                      if (pendingCmdKSuggestionRef.current && activeTabRef.current === pendingCmdKSuggestionRef.current.path) {
                        applyCmdKSuggestion();
                      } else {
                        editor.trigger("keyboard", "tab", {});
                      }
                    },
                  });
                  editor.addAction({
                    id: "dismiss-cmd-k-suggestion",
                    label: "Dismiss Cmd+K suggestion",
                    keybindings: [monaco.KeyCode.Escape],
                    run: () => {
                      if (pendingCmdKSuggestionRef.current && activeTabRef.current === pendingCmdKSuggestionRef.current.path) {
                        editor.deltaDecorations(cmdKGhostDecorationIdsRef.current, []);
                        cmdKGhostDecorationIdsRef.current = [];
                        setPendingCmdKSuggestion(null);
                      }
                    },
                  });
                  selectionDisposable.current?.dispose();
                  selectionDisposable.current = editor.onDidChangeCursorSelection(() => {
                    const sel = editor.getSelection();
                    if (!sel) return;
                    const model = editor.getModel();
                    if (!model) return;
                    const text = model.getValueInRange(sel);
                    setSelection(tab.path, text);
                  });
                  tabCompletionDisposable.current?.dispose();
                  tabCompletionDisposable.current = monaco.languages.registerInlineCompletionsProvider(
                    { pattern: "**" },
                    {
                      displayName: "AIForge Tab",
                      debounceDelayMs: TAB_COMPLETION_DEBOUNCE_MS,
                      provideInlineCompletions: async (model: Monaco.editor.ITextModel, position: Monaco.Position, _context: Monaco.languages.InlineCompletionContext, token: Monaco.CancellationToken) => {
                        const ctx = tabCompletionContextRef.current;
                        if (!ctx.workspaceId) return { items: [] };
                        const lineCount = model.getLineCount();
                        const prefixRange = { startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column };
                        const prefix = model.getValueInRange(prefixRange);
                        const prefixTail = prefix.slice(-TAB_COMPLETION_PREFIX_TAIL_LEN);
                        const cacheKey = `${ctx.workspaceId}:${ctx.filePath ?? ""}:${prefixTail}`;
                        const now = Date.now();
                        const cached = tabCompletionClientCacheRef.current.get(cacheKey);
                        if (cached && now - cached.ts < TAB_COMPLETION_CLIENT_CACHE_MS) {
                          return { items: [{ insertText: cached.completion }] };
                        }
                        setTabCompletionPendingRef.current?.(true);
                        const suffixEndLine = Math.min(position.lineNumber + 2, lineCount);
                        const suffixEndCol = suffixEndLine === position.lineNumber ? model.getLineMaxColumn(position.lineNumber) : model.getLineMaxColumn(suffixEndLine);
                        const suffixRange = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: suffixEndLine, endColumn: suffixEndCol };
                        const suffix = model.getValueInRange(suffixRange);
                        // Send smaller prefix/suffix for faster first response (fast path)
                        const prefixSend = prefix.slice(-TAB_COMPLETION_PREFIX_TAIL_LEN);
                        const suffixSend = suffix ? suffix.slice(0, 120) : undefined;
                        try {
                          const ac = new AbortController();
                          const timeoutId = setTimeout(() => ac.abort(), 4000);
                          const res = await fetch("/api/completions/tab", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              workspaceId: ctx.workspaceId,
                              filePath: ctx.filePath ?? undefined,
                              prefix: prefixSend,
                              suffix: suffixSend,
                              language: ctx.language,
                            }),
                            signal: ac.signal,
                          });
                          clearTimeout(timeoutId);
                          if (token.isCancellationRequested) return { items: [] };
                          const data = await res.json();
                          if (!res.ok || !data.completion) return { items: [] };
                          const text = String(data.completion).trim();
                          if (!text) return { items: [] };
                          const map = tabCompletionClientCacheRef.current;
                          if (map.size >= TAB_CACHE_MAX) {
                            const first = map.keys().next().value;
                            if (first) map.delete(first);
                          }
                          map.set(cacheKey, { completion: text, ts: now });
                          return { items: [{ insertText: text }] };
                        } catch {
                          return { items: [] };
                        } finally {
                          setTabCompletionPendingRef.current?.(false);
                        }
                      },
                      disposeInlineCompletions: () => {},
                    }
                  );
                  lintDisposable.current?.dispose();
                  lintDisposable.current = editor.onDidChangeModelContent(() => {
                    if (lintTimeoutRef.current) clearTimeout(lintTimeoutRef.current);
                    lintTimeoutRef.current = setTimeout(async () => {
                      lintTimeoutRef.current = null;
                      const ctx = lintContextRef.current;
                      if (!ctx.workspaceId || !ctx.filePath) return;
                      const model = editor.getModel();
                      if (!model) return;
                      const content = model.getValue();
                      try {
                        const res = await fetch(`/api/workspaces/${ctx.workspaceId}/lint`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ path: ctx.filePath, content }),
                        });
                        const data = await res.json();
                        const modelNow = editor.getModel();
                        if (!modelNow || modelNow !== model) return;
                        if (data.error) {
                          setLintErrorRef.current?.(data.error);
                          lastLintDiagnosticsRef.current = [];
                          monaco.editor.setModelMarkers(modelNow, "lint", []);
                        } else if (Array.isArray(data.diagnostics)) {
                          setLintErrorRef.current?.(null);
                          lastLintDiagnosticsRef.current = data.diagnostics as LintDiag[];
                          const markers = (data.diagnostics as Array<{ line: number; column: number; endLine?: number; endColumn?: number; message: string; severity: string }>).map((d) => ({
                            startLineNumber: d.line,
                            startColumn: d.column,
                            endLineNumber: d.endLine ?? d.line,
                            endColumn: d.endColumn ?? d.column,
                            message: d.message,
                            severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                          }));
                          monaco.editor.setModelMarkers(modelNow, "lint", markers);
                        }
                      } catch {
                        setLintErrorRef.current?.("Lint request failed");
                        lastLintDiagnosticsRef.current = [];
                      }
                    }, LINT_DEBOUNCE_MS);
                  });
                  editor.addAction({
                    id: "editor.action.applyEslintFix",
                    label: "Apply ESLint fix",
                    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period],
                    run: (ed) => {
                      const model = ed.getModel();
                      if (!model) return;
                      const pos = ed.getPosition();
                      if (!pos) return;
                      const diags = lastLintDiagnosticsRef.current;
                      if (!Array.isArray(diags)) return;
                      const d = diags.find((x) => x.line === pos.lineNumber && x.fix);
                      if (!d?.fix) return;
                      const fix = d.fix;
                      const start = model.getPositionAt(fix.range.start);
                      const end = model.getPositionAt(fix.range.end);
                      ed.executeEdits("eslint-fix", [
                        { range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: fix.text },
                      ]);
                    },
                  });
                  const runInitialLint = () => {
                    const ctx = lintContextRef.current;
                    if (!ctx.workspaceId || !ctx.filePath) return;
                    const model = editor.getModel();
                    if (!model) return;
                    fetch(`/api/workspaces/${ctx.workspaceId}/lint`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ path: ctx.filePath, content: model.getValue() }),
                    })
                      .then((r) => r.json())
                      .then((data) => {
                        const m = editor.getModel();
                        if (!m) return;
                        if (data.error) {
                          setLintErrorRef.current?.(data.error);
                          lastLintDiagnosticsRef.current = [];
                          monaco.editor.setModelMarkers(m, "lint", []);
                        } else if (Array.isArray(data.diagnostics)) {
                          setLintErrorRef.current?.(null);
                          lastLintDiagnosticsRef.current = data.diagnostics as LintDiag[];
                          const markers = (data.diagnostics as Array<{ line: number; column: number; endLine?: number; endColumn?: number; message: string; severity: string }>).map((d) => ({
                            startLineNumber: d.line,
                            startColumn: d.column,
                            endLineNumber: d.endLine ?? d.line,
                            endColumn: d.endColumn ?? d.column,
                            message: d.message,
                            severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                          }));
                          monaco.editor.setModelMarkers(m, "lint", markers);
                        }
                      })
                      .catch(() => { setLintErrorRef.current?.("Lint request failed"); lastLintDiagnosticsRef.current = []; });
                  };
                  setTimeout(runInitialLint, 400);
                }}
                theme="vs-dark"
                options={{
                  minimap: { enabled: true },
                  lineNumbers: "on",
                  fontSize: 14,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  bracketPairColorization: { enabled: true },
                  matchBrackets: "always",
                  folding: true,
                  showFoldingControls: "mouseover",
                  inlineSuggest: { enabled: true },
                  tabCompletion: "on",
                }}
              />
            </div>
            {terminalVisible && (
              <div className="h-64 shrink-0 border-t border-border">
                <TerminalPanel
                  workspaceId={workspaceId}
                  visible={terminalVisible}
                  onToggle={() => setTerminalVisible(false)}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={`flex flex-1 flex-col overflow-hidden ${terminalVisible ? "" : ""}`}>
          <div className={`flex flex-1 items-center justify-center p-8 text-muted-foreground ${terminalVisible ? "flex-1" : ""}`}>
            <p className="text-sm">Open a file from the file tree</p>
          </div>
          {terminalVisible && (
            <div className="h-64 shrink-0 border-t border-border">
              <TerminalPanel
                workspaceId={workspaceId}
                visible={terminalVisible}
                onToggle={() => setTerminalVisible(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
