"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { GitCompare, Save, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TabBar } from "@/components/tab-bar";
import { TerminalPanel } from "@/components/terminal-panel";
import { useEditor } from "@/lib/editor-context";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.default),
  { ssr: false }
);

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

/** Debounce delay (ms) before requesting Tab completion. */
const TAB_COMPLETION_DEBOUNCE_MS = 200;

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", py: "python", go: "go", rs: "rust", css: "css", html: "html",
  };
  return map[ext] ?? "plaintext";
}

export function EditorArea() {
  const {
    activeTab,
    updateContent,
    saveFile,
    getTab,
    setSelection,
    workspaceId,
  } = useEditor();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const selectionDisposable = useRef<{ dispose: () => void } | null>(null);
  const tabCompletionDisposable = useRef<{ dispose: () => void } | null>(null);
  const tabCompletionContextRef = useRef({ workspaceId: null as string | null, filePath: null as string | null, language: "plaintext" });

  const tab = activeTab ? getTab(activeTab) : null;

  useEffect(() => {
    tabCompletionContextRef.current = {
      workspaceId,
      filePath: activeTab ?? null,
      language: tab ? getLanguageFromPath(tab.path) : "plaintext",
    };
  }, [workspaceId, activeTab, tab?.path]);

  useEffect(() => {
    return () => {
      selectionDisposable.current?.dispose();
      selectionDisposable.current = null;
      tabCompletionDisposable.current?.dispose();
      tabCompletionDisposable.current = null;
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
          <div className="flex items-center gap-2 border-b border-border bg-muted/10 px-2 py-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              onClick={handleSave}
              disabled={!tab.dirty || saving}
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
              variant={terminalVisible ? "default" : "outline"}
              size="sm"
              className="h-7 gap-1"
              onClick={() => setTerminalVisible((prev) => !prev)}
              title="Toggle terminal (Ctrl+`)"
            >
              <Terminal className="h-3.5 w-3.5" />
              Terminal
            </Button>
            {tab.dirty && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
            {saveError && (
              <span className="text-xs text-destructive">{saveError}</span>
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
          <div className={`flex-1 overflow-hidden ${terminalVisible ? "flex flex-col" : ""}`}>
            <div className={terminalVisible ? "flex-1 overflow-hidden" : "h-full"}>
              <MonacoEditor
                height="100%"
                language={getLanguage(tab.path)}
                value={tab.content}
                onChange={(value) => updateContent(tab.path, value ?? "")}
                onMount={(editor, monaco) => {
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
                      provideInlineCompletions: async (model, position, _context, token) => {
                        const ctx = tabCompletionContextRef.current;
                        if (!ctx.workspaceId) return { items: [] };
                        const lineCount = model.getLineCount();
                        const prefixRange = { startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column };
                        const prefix = model.getValueInRange(prefixRange);
                        const suffixEndLine = Math.min(position.lineNumber + 6, lineCount);
                        const suffixEndCol = suffixEndLine === position.lineNumber ? model.getLineMaxColumn(position.lineNumber) : model.getLineMaxColumn(suffixEndLine);
                        const suffixRange = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: suffixEndLine, endColumn: suffixEndCol };
                        const suffix = model.getValueInRange(suffixRange);
                        try {
                          const res = await fetch("/api/completions/tab", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              workspaceId: ctx.workspaceId,
                              filePath: ctx.filePath ?? undefined,
                              prefix,
                              suffix: suffix || undefined,
                              language: ctx.language,
                            }),
                          });
                          if (token.isCancellationRequested) return { items: [] };
                          const data = await res.json();
                          if (!res.ok || !data.completion) return { items: [] };
                          const text = String(data.completion).trim();
                          if (!text) return { items: [] };
                          return { items: [{ insertText: text }] };
                        } catch {
                          return { items: [] };
                        }
                      },
                      disposeInlineCompletions: () => {},
                    }
                  );
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
