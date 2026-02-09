"use client";

import { useEffect, useState, useCallback } from "react";
import { Sparkles, TestTube, FileText, Wand2, Loader2, Copy, MessageSquarePlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/editor-context";
import { InlineEditDiffDialog } from "@/components/inline-edit-diff-dialog";
import { PROVIDERS, type ProviderId } from "@/lib/llm/providers";

type CmdKAction = "explain" | "refactor" | "test" | "docs";

interface CmdKOverlayProps {
  workspaceId: string | null;
  onAction: (action: CmdKAction, selection: string, filePath: string) => void;
}

function getStoredProvider(workspaceId: string | null): ProviderId {
  if (typeof window === "undefined") return "openrouter";
  const key = workspaceId ? `chat-provider-${workspaceId}` : "chat-provider-default";
  const stored = localStorage.getItem(key);
  return (stored && PROVIDERS.includes(stored as ProviderId)) ? (stored as ProviderId) : "openrouter";
}

function getStoredModel(workspaceId: string | null): string {
  if (typeof window === "undefined") return "openrouter/free";
  const key = workspaceId ? `chat-model-${workspaceId}` : "chat-model-default";
  return localStorage.getItem(key) || "openrouter/free";
}

export function CmdKOverlay({ workspaceId, onAction }: CmdKOverlayProps) {
  const [open, setOpen] = useState(false);
  const [inlineLoading, setInlineLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState<"edit" | "explain" | "test">("edit");
  const [inlineEdit, setInlineEdit] = useState<{ path: string; originalContent: string; newContent: string } | null>(null);
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  const [resultDialogContent, setResultDialogContent] = useState("");
  const [resultDialogAction, setResultDialogAction] = useState<"explain" | "test">("explain");
  const [resultDialogMeta, setResultDialogMeta] = useState<{ filePath: string } | null>(null);
  const { activeTab: activeTabPath, getTab, selection, updateContent, setPendingCmdKSuggestion } = useEditor();

  const actions: { id: CmdKAction; label: string; icon: React.ReactNode; description: string; useInlineEdit?: boolean }[] = [
    { id: "explain", label: "Explain this", icon: <Sparkles className="w-4 h-4" />, description: "Explain what this code does" },
    { id: "refactor", label: "Refactor this", icon: <Wand2 className="w-4 h-4" />, description: "Refactor and improve this code", useInlineEdit: true },
    { id: "test", label: "Write tests", icon: <TestTube className="w-4 h-4" />, description: "Generate tests for this code" },
    { id: "docs", label: "Add documentation", icon: <FileText className="w-4 h-4" />, description: "Add documentation comments", useInlineEdit: true },
  ];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        if (activeTabPath && workspaceId) {
          setOpen(true);
        }
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, workspaceId, activeTabPath]);

  const fallbackToChat = useCallback((action: CmdKAction, selectedText: string, filePath: string) => {
    onAction(action, selectedText, filePath);
    setOpen(false);
  }, [onAction]);

  const handleActionClick = useCallback(async (action: CmdKAction) => {
    if (!activeTabPath || !workspaceId) return;
    const activeTab = getTab(activeTabPath);
    if (!activeTab) return;

    const selectedText = selection?.text ?? activeTab.content;

    const actionConfig = actions.find((a) => a.id === action);
    if (actionConfig?.useInlineEdit && (action === "refactor" || action === "docs")) {
      setLoadingLabel("edit");
      setInlineLoading(true);
      setOpen(false);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90_000);
      try {
        const res = await fetch("/api/inline-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            filePath: activeTab.path,
            currentContent: activeTab.content,
            selection: selectedText || undefined,
            action,
            provider: getStoredProvider(workspaceId),
            model: getStoredModel(workspaceId),
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          fallbackToChat(action, selectedText, activeTab.path);
          return;
        }
        const newContent = typeof data.newContent === "string" ? data.newContent : "";
        if (data.path && newContent !== undefined) {
          // Inline-first: show suggestion as ghost text in editor; user presses Tab to accept. No diff dialog by default.
          window.dispatchEvent(new CustomEvent("cmd-k-inline-suggestion", { detail: { path: data.path, newContent: newContent || activeTab.content } }));
        } else {
          fallbackToChat(action, selectedText, activeTab.path);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          fallbackToChat(action, selectedText, activeTab.path);
        } else {
          fallbackToChat(action, selectedText, activeTab.path);
        }
      } finally {
        setInlineLoading(false);
      }
      return;
    }

    if (action === "explain" || action === "test") {
      setLoadingLabel(action);
      setInlineLoading(true);
      setOpen(false);
      const prompt =
        action === "explain"
          ? `Explain this code:\n\`\`\`\n${selectedText || activeTab.content}\n\`\`\``
          : `Write tests for this code:\n\`\`\`\n${selectedText || activeTab.content}\n\`\`\``;
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            context: {
              workspaceId,
              filePath: activeTab.path,
              fileContent: activeTab.content,
              selection: selectedText || undefined,
            },
            provider: getStoredProvider(workspaceId),
            model: getStoredModel(workspaceId),
          }),
        });
        const rawText = await res.text();
        let data: { content?: string } = {};
        try {
          data = JSON.parse(rawText) as { content?: string };
        } catch {
          // non-JSON response (e.g. HTML error page)
        }
        if (!res.ok) {
          fallbackToChat(action, selectedText, activeTab.path);
          return;
        }
        const content = typeof data.content === "string" ? data.content : "";
        if (content) {
          setResultDialogContent(content);
          setResultDialogAction(action);
          setResultDialogMeta({ filePath: activeTab.path });
          setResultDialogOpen(true);
        } else {
          fallbackToChat(action, selectedText, activeTab.path);
        }
      } catch {
        fallbackToChat(action, selectedText, activeTab.path);
      } finally {
        setInlineLoading(false);
      }
      return;
    }

    fallbackToChat(action, selectedText, activeTab.path);
  }, [activeTabPath, workspaceId, getTab, selection, fallbackToChat]);

  const handleCopyResult = useCallback(() => {
    if (resultDialogContent) {
      navigator.clipboard.writeText(resultDialogContent);
    }
  }, [resultDialogContent]);

  const handleInsertResult = useCallback(() => {
    if (!resultDialogContent || !resultDialogMeta?.filePath || !activeTabPath) return;
    const tab = getTab(resultDialogMeta.filePath);
    if (!tab) return;
    const prefix = resultDialogAction === "explain"
      ? "\n\n// Explanation:\n" + resultDialogContent.split("\n").map((l) => "// " + l).join("\n")
      : "\n\n" + resultDialogContent;
    updateContent(resultDialogMeta.filePath, tab.content + prefix);
    setResultDialogOpen(false);
    setResultDialogContent("");
    setResultDialogMeta(null);
  }, [resultDialogContent, resultDialogMeta, resultDialogAction, activeTabPath, getTab, updateContent]);

  const handleInlineAccept = useCallback(() => {
    if (!inlineEdit) return;
    updateContent(inlineEdit.path, inlineEdit.newContent);
    setInlineEdit(null);
    setPendingCmdKSuggestion(null);
  }, [inlineEdit, updateContent, setPendingCmdKSuggestion]);

  const activeTab = activeTabPath ? getTab(activeTabPath) : null;
  const hasSelection = selection !== null;

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg py-3 px-4">
          <DialogHeader className="sr-only">
            <DialogTitle>Quick Actions</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((action) => (
              <button
                key={action.id}
                onClick={() => handleActionClick(action.id)}
                disabled={inlineLoading}
                title={action.description}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-70"
              >
                {action.icon}
                <span>{action.label}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Suggestion appears as ghost text in editor. <kbd className="rounded border border-border bg-muted/50 px-1 font-mono">Tab</kbd> or <kbd className="rounded border border-border bg-muted/50 px-1 font-mono">Cmd+Enter</kbd> to accept.
          </p>
          {activeTab && (
            <p className="text-[11px] text-muted-foreground/80">
              {hasSelection ? "Using selection" : `File: ${activeTab.path}`}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {inlineLoading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="flex flex-col items-center gap-2 rounded-lg border bg-background px-6 py-4 shadow-lg">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {loadingLabel === "edit" && "Generating edit…"}
              {loadingLabel === "explain" && "Generating explanation…"}
              {loadingLabel === "test" && "Generating tests…"}
            </span>
          </div>
        </div>
      )}

      {inlineEdit && workspaceId && (
        <InlineEditDiffDialog
          open={!!inlineEdit}
          onOpenChange={(o) => { if (!o) { setInlineEdit(null); setPendingCmdKSuggestion(null); } }}
          path={inlineEdit.path}
          originalContent={inlineEdit.originalContent}
          newContent={inlineEdit.newContent}
          workspaceId={workspaceId}
          onAccept={handleInlineAccept}
          onReject={() => { setInlineEdit(null); setPendingCmdKSuggestion(null); }}
        />
      )}

      <Dialog open={resultDialogOpen} onOpenChange={setResultDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{resultDialogAction === "explain" ? "Explain" : "Write tests"}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0 rounded border border-border bg-muted/20 p-3 text-sm whitespace-pre-wrap break-words">
            {resultDialogContent}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={handleCopyResult} className="gap-2">
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button size="sm" onClick={handleInsertResult} className="gap-2">
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {resultDialogAction === "explain" ? "Insert as comment" : "Insert at end of file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
