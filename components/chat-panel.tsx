"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Send, Loader2, Sparkles, Check, ChevronDown, ChevronRight, GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditor } from "@/lib/editor-context";
import { useWorkspaceLabel } from "@/lib/use-workspace-label";
import { PROVIDERS, PROVIDER_LABELS, OPENROUTER_FREE_MODELS, type ProviderId, type OpenRouterModelId } from "@/lib/llm/providers";
import { AgentPanel } from "@/components/agent-panel";
import { ComposerPanel } from "@/components/composer-panel";
import type { FileEditStep } from "@/lib/agent/types";
import { SAFE_EDIT_MAX_FILES } from "@/lib/protected-paths";
import { COPY } from "@/lib/copy";
import { ErrorWithAction } from "@/components/error-with-action";
import { FeedbackPrompt } from "@/components/feedback-prompt";
import type { LogAttachment } from "@/lib/chat/log-utils";
import { looksLikeLog, createLogAttachment } from "@/lib/chat/log-utils";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

type DebugReviewStep = {
  path: string;
  originalContent: string;
  newContent: string;
  oldContent?: string;
  description?: string;
};

function getLanguage(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", py: "python", css: "css", html: "html",
  };
  return map[ext] ?? "plaintext";
}

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  logAttachment?: LogAttachment;
};

type ChatPanelProps = {
  workspaceId: string | null;
  activeTab: "chat" | "composer" | "agent";
};

function buildContext(
  workspaceId: string | null,
  filePath: string | null,
  fileContent: string | undefined,
  selection: { path: string; text: string } | null
) {
  const sel = selection && selection.path === filePath ? selection.text : undefined;
  return {
    workspaceId: workspaceId ?? undefined,
    filePath: filePath ?? undefined,
    fileContent: fileContent ?? undefined,
    selection: sel,
  };
}

export function ChatPanel({
  workspaceId,
  activeTab,
}: ChatPanelProps) {
  const { activeTab: activeFilePath, getTab, selection, updateContent, openFile } = useEditor();
  const workspaceLabel = useWorkspaceLabel(workspaceId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugSummary, setDebugSummary] = useState<string | null>(null);
  const [debugRootCause, setDebugRootCause] = useState<string | null>(null);
  const [debugReviewSteps, setDebugReviewSteps] = useState<DebugReviewStep[]>([]);
  const [debugSandboxChecks, setDebugSandboxChecks] = useState<{ lint: { passed: boolean; logs: string }; tests: { passed: boolean; logs: string } } | null>(null);
  const [debugSelectedPaths, setDebugSelectedPaths] = useState<Set<string>>(new Set());
  const [debugExpandedPath, setDebugExpandedPath] = useState<string | null>(null);
  const [debugApplying, setDebugApplying] = useState(false);
  const [debugProtectedConfirmOpen, setDebugProtectedConfirmOpen] = useState(false);
  const [debugProtectedPathsList, setDebugProtectedPathsList] = useState<string[]>([]);
  const [debugPendingStepsForProtected, setDebugPendingStepsForProtected] = useState<FileEditStep[] | null>(null);
  const [debugLargeConfirmOpen, setDebugLargeConfirmOpen] = useState(false);
  const [debugLargeCount, setDebugLargeCount] = useState(0);
  const [debugPendingStepsForApply, setDebugPendingStepsForApply] = useState<FileEditStep[] | null>(null);
  
  // Load provider and model from localStorage, default to openrouter + deepseek-coder:free
  const getStoredProvider = (): ProviderId => {
    if (typeof window === "undefined") return "openrouter";
    const key = workspaceId ? `chat-provider-${workspaceId}` : "chat-provider-default";
    const stored = localStorage.getItem(key);
    return (stored && PROVIDERS.includes(stored as ProviderId)) ? (stored as ProviderId) : "openrouter";
  };

  const getStoredModel = (): string => {
    if (typeof window === "undefined") return "openrouter/free";
    const key = workspaceId ? `chat-model-${workspaceId}` : "chat-model-default";
    const stored = localStorage.getItem(key);
    const m = stored || "openrouter/free";
    if (m === "deepseek/deepseek-coder:free" || m === "deepseek/deepseek-r1:free") return "openrouter/free";
    return m;
  };
  
  // Use fixed initial state so server and client match (avoid hydration error from localStorage)
  const [provider, setProviderState] = useState<ProviderId>("openrouter");
  const [model, setModelState] = useState<string>("openrouter/free");
  const [loading, setLoading] = useState(false);
  const [rulesFile, setRulesFile] = useState<string | null>(null);
  const [usageText, setUsageText] = useState<string | null>(null);
  const [lastContextUsed, setLastContextUsed] = useState<{ filePaths: string[]; rulesIncluded: boolean } | null>(null);
  const [errorLogConfirmOpen, setErrorLogConfirmOpen] = useState(false);
  const [pendingLogMessage, setPendingLogMessage] = useState<string | null>(null);
  const [workspaceIdWhenLogPasted, setWorkspaceIdWhenLogPasted] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | "chat" | "debug">("all");
  const [showDebugFeedback, setShowDebugFeedback] = useState(false);
  const [debugRetrySummary, setDebugRetrySummary] = useState<{ attempt1: boolean; attempt2: boolean } | null>(null);
  const [logAttachment, setLogAttachment] = useState<LogAttachment | null>(null);
  const [useDebugForLogs, setUseDebugForLogs] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("useDebugForLogs");
    return stored !== "false";
  });
  const [expandedLogMessageId, setExpandedLogMessageId] = useState<string | null>(null);

  const runDebugFromLog = useCallback(
    async (wsId: string, logText: string, options?: { userMessageContent?: string; logAttachment?: LogAttachment }) => {
      setDebugRunWorkspaceId(wsId);
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: options?.userMessageContent ?? logText,
        logAttachment: options?.logAttachment,
      };
      setMessages((prev) => [...prev, userMsg]);
      setErrorLogConfirmOpen(false);
      setPendingLogMessage(null);
      setWorkspaceIdWhenLogPasted(null);
      setDebugLoading(true);
      setError(null);
      try {
        const scopeMode = (typeof window !== "undefined" && wsId)
          ? (localStorage.getItem(`composer-scope-mode-${wsId}`) || localStorage.getItem(`agent-scope-mode-${wsId}`) || "normal")
          : "normal";
        const res = await fetch(`/api/workspaces/${wsId}/debug-from-log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            logText,
            provider,
            model: provider === "openrouter" ? model : undefined,
            scopeMode: scopeMode === "conservative" || scopeMode === "aggressive" ? scopeMode : "normal",
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Debug request failed");
        }
        const explanation = data.explanation ?? data.summary ?? "Analysis complete.";
        const suspectedRootCause = data.suspectedRootCause ?? "";
        const rawEdits = Array.isArray(data.edits) ? data.edits : [];
        const steps: DebugReviewStep[] = [];
        for (const e of rawEdits) {
          const path = typeof e.path === "string" ? e.path.trim() : "";
          const newContent = typeof e.newContent === "string" ? e.newContent : "";
          if (!path || !newContent) continue;
          let originalContent = "";
          try {
            const fileRes = await fetch(
              `/api/workspaces/${wsId}/files?path=${encodeURIComponent(path)}`
            );
            if (fileRes.ok) {
              const fileData = await fileRes.json();
              originalContent = fileData.content ?? "";
            }
          } catch {
            // keep empty (e.g. new file)
          }
          steps.push({
            path,
            originalContent,
            newContent,
            oldContent: typeof e.oldContent === "string" && e.oldContent.trim() ? e.oldContent.trim() : undefined,
            description: typeof e.description === "string" && e.description.trim() ? e.description.trim() : undefined,
          });
        }
        setDebugSummary(explanation);
        setDebugRootCause(suspectedRootCause || null);
        setDebugReviewSteps(steps);
        setDebugSelectedPaths(new Set(steps.map((s) => s.path)));
        setDebugExpandedPath(null);
        setDebugFromLogMeta({
          errorLog: logText,
          errorType: suspectedRootCause || null,
          modelUsed: provider === "openrouter" ? model : undefined,
          providerId: provider,
        });
        let workspaceName = "this workspace";
        try {
          const nameRes = await fetch(`/api/workspaces/${wsId}`);
          if (nameRes.ok) {
            const wsData = await nameRes.json();
            workspaceName = wsData?.name ?? workspaceName;
          }
        } catch {
          // use fallback
        }
        const body =
          suspectedRootCause.length > 0
            ? `**Suspected root cause:** ${suspectedRootCause}\n\n${explanation}`
            : explanation;
        const sandboxNote = steps.length > 0
          ? `\n\n**Note:** When you apply these changes, they will be tested in a sandbox (lint + tests) before being applied to your workspace. Only passing changes will be applied.`
          : "";
        const assistantContent = `**Debugged from runtime logs — ${workspaceName}**\n\n${body}${
          steps.length > 0
            ? `\n\nProposed changes in ${steps.length} file(s). Review and apply below.${sandboxNote}`
            : ""
        }`;
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: assistantContent },
        ]);
        fetch("/api/chat/save-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: wsId, role: "assistant", content: assistantContent, runType: "debug" }),
        }).catch(() => {});
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Debug failed";
        setError(errMsg);
        const failContent = `Debug failed: ${errMsg}`;
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: failContent },
        ]);
        fetch("/api/chat/save-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId: wsId, role: "assistant", content: failContent, runType: "debug" }),
        }).catch(() => {});
      } finally {
        setDebugLoading(false);
      }
    },
    [provider, model]
  );

  // When switching to chat from Agent with pending debug log, run it
  useEffect(() => {
    if (activeTab !== "chat" || !workspaceId) return;
    try {
      const raw = sessionStorage.getItem("pendingDebugLog");
      if (!raw) return;
      const { logText, userMessageContent, logAttachment } = JSON.parse(raw) as {
        logText: string;
        userMessageContent?: string;
        logAttachment?: LogAttachment;
      };
      sessionStorage.removeItem("pendingDebugLog");
      if (logText) {
        runDebugFromLog(workspaceId, logText, { userMessageContent, logAttachment });
      }
    } catch {
      sessionStorage.removeItem("pendingDebugLog");
    }
  }, [activeTab, workspaceId, runDebugFromLog]);

  // Restore chat history on mount and when filter changes
  useEffect(() => {
    if (!workspaceId) return;
    const runType = historyFilter === "all" ? undefined : historyFilter;
    const q = new URLSearchParams({ workspaceId });
    if (runType) q.set("runType", runType);
    fetch(`/api/chat/history?${q}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data: { messages?: { role: string; content: string }[] }) => {
        const list = Array.isArray(data.messages) ? data.messages : [];
        setMessages(
          list.map((m) => ({
            id: crypto.randomUUID(),
            role: m.role === "user" ? "user" : "assistant",
            content: m.content,
          }))
        );
      })
      .catch(() => {});
  }, [workspaceId, historyFilter]);

  // Handle CMD+K actions
  useEffect(() => {
    const handleCmdKAction = (e: CustomEvent<{ action: string; selection: string; filePath: string }>) => {
      const { action, selection, filePath } = e.detail;
      let prompt = "";
      
      switch (action) {
        case "explain":
          prompt = `Explain this code:\n\`\`\`\n${selection}\n\`\`\``;
          break;
        case "refactor":
          prompt = `Refactor and improve this code:\n\`\`\`\n${selection}\n\`\`\``;
          break;
        case "test":
          prompt = `Write comprehensive tests for this code:\n\`\`\`\n${selection}\n\`\`\``;
          break;
        case "docs":
          prompt = `Add documentation comments to this code:\n\`\`\`\n${selection}\n\`\`\``;
          break;
        default:
          return;
      }
      
      setInput(prompt);
      // Auto-send after a brief delay
      setTimeout(() => {
        sendMessage(prompt);
      }, 100);
    };

    window.addEventListener("cmd-k-action", handleCmdKAction as EventListener);
    return () => window.removeEventListener("cmd-k-action", handleCmdKAction as EventListener);
  }, []);

  // Handle slash commands
  const handleSlashCommand = useCallback((inputText: string): string | null => {
    const trimmed = inputText.trim();
    if (!trimmed.startsWith("/")) return null;

    const [command, ...rest] = trimmed.slice(1).split(/\s+/);
    const args = rest.join(" ");

    const activeTab = getTab(activeFilePath || "");
    const selectedText = selection || activeTab?.content || "";

    switch (command.toLowerCase()) {
      case "test":
        return `Write tests for ${args || "this code"}:\n\`\`\`\n${selectedText || "the current file"}\n\`\`\``;
      case "fix":
        return `Fix this error or issue:\n${args || selectedText || "the current problem"}`;
      case "docs":
        return `Add documentation to ${args || "this code"}:\n\`\`\`\n${selectedText || "the current file"}\n\`\`\``;
      case "explain":
        return `Explain ${args || "this code"}:\n\`\`\`\n${selectedText || "the current file"}\n\`\`\``;
      default:
        return null;
    }
  }, [activeFilePath, selection, getTab]);
  const [debugRunWorkspaceId, setDebugRunWorkspaceId] = useState<string | null>(null);
  const [debugFromLogMeta, setDebugFromLogMeta] = useState<{ errorLog: string; errorType: string | null; modelUsed?: string; providerId?: string } | null>(null);
  const [noWorkspaceErrorLogNote, setNoWorkspaceErrorLogNote] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Prevent hydration mismatch for Radix UI components
  useEffect(() => {
    setMounted(true);
  }, []);
  const [errorLogConfirmAlreadyHasUserMessage, setErrorLogConfirmAlreadyHasUserMessage] = useState(false);
  const [prAnalyzeOpen, setPrAnalyzeOpen] = useState(false);
  const [prAnalyzeDiff, setPrAnalyzeDiff] = useState("");
  const [prAnalyzeLoading, setPrAnalyzeLoading] = useState(false);
  const [prAnalyzeResult, setPrAnalyzeResult] = useState<{ summary: string; risks: string[]; suggestions: string[] } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Persist provider selection
  const setProvider = useCallback((newProvider: ProviderId) => {
    setProviderState(newProvider);
    if (typeof window !== "undefined") {
      const key = workspaceId ? `chat-provider-${workspaceId}` : "chat-provider-default";
      localStorage.setItem(key, newProvider);
      // Reset model to default if switching away from OpenRouter
      if (newProvider !== "openrouter") {
        const modelKey = workspaceId ? `chat-model-${workspaceId}` : "chat-model-default";
        localStorage.removeItem(modelKey);
        setModelState("");
      } else if (!model || !OPENROUTER_FREE_MODELS.some(m => m.id === model)) {
        setModelState("openrouter/free");
      }
    }
  }, [workspaceId, model]);

  // Persist model selection
  const setModel = useCallback((newModel: string) => {
    setModelState(newModel);
    if (typeof window !== "undefined") {
      const key = workspaceId ? `chat-model-${workspaceId}` : "chat-model-default";
      localStorage.setItem(key, newModel);
    }
  }, [workspaceId]);

  // Client-only: sync provider/model from localStorage when workspace or mount changes; fetch best-default if no stored preference.
  // Single effect with stable deps [workspaceId, mounted] to avoid "useEffect changed size" between renders.
  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    setProviderState(getStoredProvider());
    setModelState(getStoredModel());
    if (!workspaceId) return;
    const providerKey = workspaceId ? `chat-provider-${workspaceId}` : "chat-provider-default";
    const modelKey = workspaceId ? `chat-model-${workspaceId}` : "chat-model-default";
    if (localStorage.getItem(providerKey) != null && localStorage.getItem(modelKey) != null) return;
    let cancelled = false;
    fetch("/api/models/best-default")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled || !data?.provider) return;
        const p = PROVIDERS.includes(data.provider) ? data.provider : "openrouter";
        const m = (typeof data.modelSlug === "string" ? data.modelSlug : "openrouter/free") || "openrouter/free";
        localStorage.setItem(providerKey, p);
        localStorage.setItem(modelKey, p === "openrouter" ? m : "");
        setProviderState(p);
        setModelState(p === "openrouter" ? m : "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, mounted]);

  const tab = activeFilePath ? getTab(activeFilePath) : null;

  const applyDebugEdits = useCallback(
    async (steps: FileEditStep[], confirmedProtectedPaths?: string[]) => {
      const effectiveWorkspaceId = debugRunWorkspaceId ?? workspaceId;
      if (!effectiveWorkspaceId || steps.length === 0) return;
      setDebugApplying(true);
      setError(null);
      try {
        const scopeMode = (typeof window !== "undefined" && effectiveWorkspaceId)
          ? (localStorage.getItem(`composer-scope-mode-${effectiveWorkspaceId}`) || localStorage.getItem(`agent-scope-mode-${effectiveWorkspaceId}`) || "normal")
          : "normal";
        const res = await fetch("/api/composer/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: effectiveWorkspaceId,
            steps,
            confirmedProtectedPaths: confirmedProtectedPaths ?? undefined,
            source: "debug-from-log",
            scopeMode: scopeMode === "conservative" || scopeMode === "aggressive" ? scopeMode : "normal",
            debugFromLogMeta: debugFromLogMeta
              ? {
                  errorLog: debugFromLogMeta.errorLog,
                  errorType: debugFromLogMeta.errorType ?? undefined,
                  modelUsed: debugFromLogMeta.modelUsed,
                  providerId: debugFromLogMeta.providerId,
                }
              : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.retried && data.attempt1 && data.attempt2) {
            setDebugRetrySummary({
              attempt1: data.attempt1.testsPassed === true,
              attempt2: data.attempt2.testsPassed === true,
            });
          }
          throw new Error(data.message || data.error || "Apply failed");
        }
        if (data.needProtectedConfirmation && Array.isArray(data.protectedPaths)) {
          setDebugProtectedPathsList(data.protectedPaths);
          setDebugPendingStepsForProtected(steps);
          setDebugProtectedConfirmOpen(true);
          setDebugApplying(false);
          return;
        }
        const conflicts = (data.conflicts as { path: string; message: string }[]) ?? [];
        if (conflicts.length > 0) {
          const msg = conflicts.length === 1
            ? COPY.conflict.single(conflicts[0].path)
            : COPY.conflict.multiple(conflicts.map((c) => c.path));
          setError(msg);
        }
        // Store sandbox check results if available
        if (data.sandboxChecks) {
          setDebugSandboxChecks(data.sandboxChecks);
        }
        if (data.retried && data.attempt1 && data.attempt2) {
          setDebugRetrySummary({
            attempt1: data.attempt1.testsPassed === true,
            attempt2: data.attempt2.testsPassed === true,
          });
        } else {
          setDebugRetrySummary(null);
        }
        for (const path of data.filesEdited ?? []) {
          const fileRes = await fetch(
            `/api/workspaces/${effectiveWorkspaceId}/files?path=${encodeURIComponent(path)}`
          );
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            const content = fileData.content ?? "";
            const t = getTab(path);
            if (t) updateContent(path, content);
            else openFile(path, content);
          }
        }
        setDebugReviewSteps([]);
        setDebugSummary(null);
        setDebugRootCause(null);
        setDebugSelectedPaths(new Set());
        setDebugRunWorkspaceId(null);
        setDebugSandboxChecks(null);
        setDebugFromLogMeta(null);
        setShowDebugFeedback(true);
        window.dispatchEvent(new CustomEvent("refresh-file-tree"));
      } catch (e) {
        setDebugRetrySummary(null);
        setError(e instanceof Error ? e.message : "Apply failed");
      } finally {
        setDebugApplying(false);
      }
    },
    [workspaceId, debugRunWorkspaceId, debugFromLogMeta, getTab, updateContent, openFile]
  );

  const applyDebugSelected = useCallback(() => {
    const effectiveWorkspaceId = debugRunWorkspaceId ?? workspaceId;
    if (!effectiveWorkspaceId || debugReviewSteps.length === 0) return;
    const toApply = debugReviewSteps.filter((s) => debugSelectedPaths.has(s.path));
    if (toApply.length === 0) return;
    const steps: FileEditStep[] = toApply.map((s) => ({
      type: "file_edit" as const,
      path: s.path,
      newContent: s.newContent,
      ...(s.oldContent != null && s.oldContent !== "" ? { oldContent: s.oldContent } : {}),
      source: "debug-from-log" as const,
    }));
    (async () => {
      try {
        const wsRes = await fetch(`/api/workspaces/${effectiveWorkspaceId}`);
        const ws = await wsRes.json();
        const safeEditMode = ws.safe_edit_mode !== false;
        if (safeEditMode && toApply.length > SAFE_EDIT_MAX_FILES) {
          setDebugLargeCount(toApply.length);
          setDebugPendingStepsForApply(steps);
          setDebugLargeConfirmOpen(true);
          return;
        }
        await applyDebugEdits(steps);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Apply failed");
      }
    })();
  }, [workspaceId, debugRunWorkspaceId, debugReviewSteps, debugSelectedPaths, applyDebugEdits]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!workspaceId) {
      setRulesFile(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/rules-info`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.rulesFile != null) setRulesFile(data.rulesFile);
        else if (!cancelled) setRulesFile(null);
      })
      .catch(() => { if (!cancelled) setRulesFile(null); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const NO_WORKSPACE_NOTE =
    "I don't know which project this error belongs to; select a workspace and paste the logs again if you want me to modify code.\n\n";

  async function sendMessage(content: string, options?: { prependNoWorkspaceNote?: boolean; treatAsNormal?: boolean; skipAddingUserMessage?: boolean }) {
    if (!content.trim() || loading) return;

    if (!options?.skipAddingUserMessage) {
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: content.trim(),
      };
      setMessages((prev) => [...prev, userMessage]);
    }
    setInput("");
    setLoading(true);
    setUsageText(null);
    setLastContextUsed(null);
    setError(null);
    setNoWorkspaceErrorLogNote(false);

    const chatMessages = options?.skipAddingUserMessage
      ? messages.map((m) => ({ role: m.role, content: m.content }))
      : [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: content.trim() },
        ];
    const context = buildContext(
      workspaceId,
      activeFilePath,
      tab?.content,
      selection
    );

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: chatMessages,
          context,
          provider,
          model: provider === "openrouter" ? model : undefined,
          treatAsNormal: options?.treatAsNormal,
          runType: "chat",
        }),
      });

      const rawText = await res.text();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(rawText) as Record<string, unknown>;
      } catch (jsonError) {
        throw new Error(`Invalid JSON response: ${jsonError instanceof Error ? jsonError.message : "Unknown error"}. Status: ${res.status}. Response: ${rawText.slice(0, 200)}`);
      }

      if (data.requireConfirmation === true && data.kind === "error_log" && data.workspaceId) {
        setPendingLogMessage(content.trim());
        setWorkspaceIdWhenLogPasted(workspaceId);
        setErrorLogConfirmAlreadyHasUserMessage(true);
        setErrorLogConfirmOpen(true);
        setLoading(false);
        return;
      }
      if (data.noWorkspaceErrorLog === true) {
        setNoWorkspaceErrorLogNote(true);
      }
      if (!res.ok) {
        const errorMsg = data.error || `Request failed: ${res.status}`;
        if (errorMsg.includes("No API key configured") && provider === "openrouter") {
          throw new Error(`OpenRouter: No API key configured. Click 'Get free key' in API Keys settings to set it up.`);
        }
        throw new Error(`${PROVIDER_LABELS[provider]}: ${errorMsg}`);
      }
      if (data.error) {
        if (data.error.includes("No API key configured") && provider === "openrouter") {
          throw new Error(`OpenRouter: No API key configured. Click 'Get free key' in API Keys settings to set it up.`);
        }
        throw new Error(`${PROVIDER_LABELS[provider]}: ${data.error}`);
      }
      if (data.usage) {
        const u = data.usage as {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        const parts: string[] = [];
        if (u.totalTokens != null) {
          parts.push(`Total: ${u.totalTokens.toLocaleString()} tokens`);
        }
        if (u.inputTokens != null && u.outputTokens != null) {
          parts.push(`Input: ${u.inputTokens.toLocaleString()} | Output: ${u.outputTokens.toLocaleString()}`);
        } else {
          if (u.inputTokens != null) parts.push(`Input: ${u.inputTokens.toLocaleString()}`);
          if (u.outputTokens != null) parts.push(`Output: ${u.outputTokens.toLocaleString()}`);
        }
        // Rough cost estimate for OpenAI GPT-4o-mini (approximate)
        if (provider === "openai" && u.inputTokens != null && u.outputTokens != null) {
          const inputCost = (u.inputTokens / 1_000_000) * 0.15; // $0.15 per 1M input tokens
          const outputCost = (u.outputTokens / 1_000_000) * 0.6; // $0.60 per 1M output tokens
          const totalCost = inputCost + outputCost;
          if (totalCost > 0.0001) {
            parts.push(`Est. cost: $${totalCost.toFixed(4)}`);
          }
        }
        if (parts.length > 0) {
          setUsageText(parts.join(" • "));
        }
      }
      if (data.contextUsed && Array.isArray(data.contextUsed.filePaths)) {
        setLastContextUsed({
          filePaths: data.contextUsed.filePaths,
          rulesIncluded: !!data.contextUsed.rulesIncluded,
        });
      }
      let assistantContent = data.content as string;
      if (options?.prependNoWorkspaceNote && assistantContent) {
        assistantContent = NO_WORKSPACE_NOTE + assistantContent;
      }
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantContent,
        },
      ]);
    } catch (e) {
      let errMsg = e instanceof Error ? e.message : "Failed to send";
      if (errMsg.toLowerCase().includes("not a valid model") || errMsg.includes("invalid model")) {
        errMsg += " If you use an OpenAI key, switch the Provider dropdown above to \"OpenAI\".";
      }
      setError(errMsg);
    } finally {
      setLoading(false);
    }
  }

  function handleExplain() {
    if (selection?.text) {
      sendMessage(
        `Please explain the following code:\n\n\`\`\`\n${selection.text}\n\`\`\``
      );
    } else if (tab) {
      sendMessage(
        `Please explain the following file (${tab.path}):\n\n\`\`\`\n${tab.content}\n\`\`\``
      );
    } else {
      setError("No file or selection to explain");
    }
  }

  if (activeTab === "agent") {
    return <AgentPanel workspaceId={workspaceId} />;
  }
  if (activeTab === "composer") {
    return <ComposerPanel workspaceId={workspaceId} />;
  }

  if (!workspaceId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-center">
        <p className="text-sm text-muted-foreground">
          Select or create a workspace to start coding. I&apos;ll scope all edits and debugging to that workspace.
        </p>
      </div>
    );
  }

  const workspaceLabelText = workspaceLabel
    ? `Workspace: ${workspaceLabel.name}${workspaceLabel.branch ? ` (${workspaceLabel.branch})` : ""}`
    : "Workspace: …";

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <p className="text-xs font-medium text-muted-foreground truncate" title={workspaceLabelText}>
          {workspaceLabelText}
        </p>
        <p className="text-[11px] text-muted-foreground/90 flex items-center gap-1.5 flex-wrap">
          <span>Rules: {rulesFile ?? "No rules file"}</span>
          {lastContextUsed?.rulesIncluded !== undefined && (
            <span className="text-muted-foreground/70">• Used in last request: {lastContextUsed.rulesIncluded ? "Yes" : "No"}</span>
          )}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("open-rules-editor"))}
            className="text-primary hover:underline text-[11px]"
          >
            Edit rules
          </button>
        </p>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Provider:</span>
            {mounted ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-xs font-medium">
                    {PROVIDER_LABELS[provider]} ▼
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {PROVIDERS.map((p) => (
                    <DropdownMenuItem
                      key={p}
                      onClick={() => setProvider(p)}
                      className={p === provider ? "bg-accent" : ""}
                    >
                      {PROVIDER_LABELS[p]}
                      {p === provider && <span className="ml-2 text-xs">✓</span>}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="outline" size="sm" className="h-7 text-xs font-medium" disabled>
                {PROVIDER_LABELS[provider]} ▼
              </Button>
            )}
          </div>
        {provider === "openrouter" && (
          mounted ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs font-medium">
                  {OPENROUTER_FREE_MODELS.find(m => m.id === model)?.label || model} ▼
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {OPENROUTER_FREE_MODELS.map((m) => (
                  <DropdownMenuItem
                    key={m.id}
                    onClick={() => setModel(m.id)}
                    className={m.id === model ? "bg-accent" : ""}
                  >
                    {m.label}
                    {m.id === model && <span className="ml-2 text-xs">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button variant="outline" size="sm" className="h-7 text-xs font-medium" disabled>
              {OPENROUTER_FREE_MODELS.find(m => m.id === model)?.label || model} ▼
            </Button>
          )
        )}
          {mounted && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs font-medium">
                  History: {historyFilter === "all" ? "All" : historyFilter === "chat" ? "Chat" : "Debug runs"} ▼
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setHistoryFilter("all")} className={historyFilter === "all" ? "bg-accent" : ""}>
                  All
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setHistoryFilter("chat")} className={historyFilter === "chat" ? "bg-accent" : ""}>
                  Chat
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setHistoryFilter("debug")} className={historyFilter === "debug" ? "bg-accent" : ""}>
                  Debug runs
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs font-medium"
            onClick={() => { setPrAnalyzeOpen(true); setPrAnalyzeResult(null); setPrAnalyzeDiff(""); }}
          >
            <GitPullRequest className="h-3.5 w-3.5 mr-1" />
            Analyze PR
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {usageText && (
          <div className="flex items-center justify-end gap-2">
            <div className="rounded-md bg-muted/80 px-2.5 py-1 text-xs text-muted-foreground border border-border/50">
              <div className="font-medium text-foreground/80 mb-0.5">Token Usage</div>
              <div className="space-y-0.5">{usageText}</div>
            </div>
          </div>
        )}
        {lastContextUsed && (lastContextUsed.filePaths.length > 0 || lastContextUsed.rulesIncluded) && (
          <div className="rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground border border-border/50">
            <div className="font-medium text-foreground/80 mb-1">Context used</div>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5">
              {lastContextUsed.filePaths.slice(0, 10).map((p) => (
                <span key={p} className="font-mono truncate max-w-[200px]" title={p}>{p}</span>
              ))}
              {lastContextUsed.filePaths.length > 10 && (
                <span className="text-muted-foreground/80">+{lastContextUsed.filePaths.length - 10} more</span>
              )}
              {lastContextUsed.rulesIncluded && (
                <span className="text-muted-foreground/80">• Project rules</span>
              )}
            </div>
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-xs text-muted-foreground py-4 px-1 space-y-1">
            <p>Try <kbd className="rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">Cmd+K</kbd> on a selection for quick actions, or ask about your code below.</p>
            <p>Index runs when you open a workspace; use the database icon in the file tree to rebuild for cross-file go-to-def (F12).</p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg px-3 py-2 text-sm ${
              m.role === "user"
                ? "ml-4 bg-primary text-primary-foreground"
                : "mr-4 bg-muted"
            }`}
          >
            <div className="whitespace-pre-wrap break-words">{m.content}</div>
            {m.logAttachment && (
              <div className="mt-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => setExpandedLogMessageId((id) => (id === m.id ? null : m.id))}
                  className={
                    m.role === "user"
                      ? "rounded bg-primary-foreground/20 px-2 py-1 hover:bg-primary-foreground/30 text-primary-foreground"
                      : "rounded bg-slate-800 px-2 py-1 hover:bg-slate-700 text-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600"
                  }
                >
                  🖥 {m.logAttachment.source ?? "log"} ({m.logAttachment.lineCount} lines) – {expandedLogMessageId === m.id ? "Hide" : "View"}
                </button>
                {expandedLogMessageId === m.id && (
                  <pre
                    className={
                      m.role === "user"
                        ? "mt-2 max-h-64 overflow-auto rounded bg-primary-foreground/10 p-2 text-xs text-primary-foreground whitespace-pre-wrap break-words"
                        : "mt-2 max-h-64 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100 whitespace-pre-wrap break-words"
                    }
                  >
                    {m.logAttachment.fullText}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="mr-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking…
          </div>
        )}
        {error && (
          <ErrorWithAction
            message={error}
            onRetry={
              messages.length > 0 && messages[messages.length - 1]?.role === "user"
                ? () => {
                    setError(null);
                    const last = messages[messages.length - 1];
                    if (last?.role === "user" && last.content) {
                      sendMessage(last.content, { skipAddingUserMessage: true });
                    }
                  }
                : undefined
            }
          />
        )}
        {debugLoading && (
          <div className="mr-4 flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing error log…
          </div>
        )}
        {debugReviewSteps.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Debugging error in workspace: {workspaceLabel?.name ?? "this workspace"}
            </p>
            {debugRootCause && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
                <span className="font-medium text-amber-700 dark:text-amber-400">Suspected root cause:</span>{" "}
                {debugRootCause}
              </div>
            )}
            {debugSummary && (
              <p className="text-sm text-muted-foreground">{debugSummary}</p>
            )}
            {debugSandboxChecks && (
              <div className="rounded border border-border bg-muted/30 p-2 text-xs">
                <div className="font-medium mb-1">Sandbox run:</div>
                <div className="space-y-1">
                  <div className="flex items-start gap-2">
                    <span>Lint:</span>
                    <div className="flex-1">
                      <span className={`font-mono ${
                        debugSandboxChecks.lint.status === 'passed' ? 'text-green-600 dark:text-green-400' : 
                        debugSandboxChecks.lint.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                        'text-muted-foreground'
                      }`}>
                        {debugSandboxChecks.lint.status === 'passed' ? '✓ passed' : 
                         debugSandboxChecks.lint.status === 'failed' ? '✗ failed' :
                         debugSandboxChecks.lint.status === 'skipped' ? '⊘ skipped' : '○ not configured'}
                      </span>
                      {debugSandboxChecks.lint.logs && debugSandboxChecks.lint.status === 'failed' && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-16 overflow-y-auto bg-background/50 p-1 rounded">
                          {debugSandboxChecks.lint.logs}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <span>Tests:</span>
                    <div className="flex-1">
                      <span className={`font-mono ${
                        debugSandboxChecks.tests.status === 'passed' ? 'text-green-600 dark:text-green-400' : 
                        debugSandboxChecks.tests.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                        'text-muted-foreground'
                      }`}>
                        {debugSandboxChecks.tests.status === 'passed' ? '✓ passed' : 
                         debugSandboxChecks.tests.status === 'failed' ? '✗ failed' :
                         debugSandboxChecks.tests.status === 'skipped' ? '⊘ skipped' : '○ not configured'}
                      </span>
                      {debugSandboxChecks.tests.logs && debugSandboxChecks.tests.status === 'failed' && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-16 overflow-y-auto bg-background/50 p-1 rounded">
                          {debugSandboxChecks.tests.logs}
                        </div>
                      )}
                    </div>
                  </div>
                  {debugSandboxChecks.run && (
                    <div className="flex items-start gap-2">
                      <span>Run:</span>
                      <div className="flex-1">
                        <span className={`font-mono ${
                          debugSandboxChecks.run.status === 'passed' ? 'text-green-600 dark:text-green-400' : 
                          debugSandboxChecks.run.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                          'text-muted-foreground'
                        }`}>
                          {debugSandboxChecks.run.status === 'passed' ? '✓ passed' : 
                           debugSandboxChecks.run.status === 'failed' ? '✗ failed' :
                           debugSandboxChecks.run.status === 'skipped' ? '⊘ skipped' : '○ not configured'}
                        </span>
                        {debugSandboxChecks.run.logs && debugSandboxChecks.run.status === 'failed' && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-16 overflow-y-auto bg-background/50 p-1 rounded">
                            {debugSandboxChecks.run.logs}
                          </div>
                        )}
                        {debugSandboxChecks.run.port && (
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            Running on port {debugSandboxChecks.run.port}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {debugSandboxChecks.lint.status === 'failed' || debugSandboxChecks.tests.status === 'failed' || (debugSandboxChecks.run && debugSandboxChecks.run.status === 'failed') ? (
                    <p className="text-amber-600 dark:text-amber-400 mt-1 italic text-[11px]">
                      Sandbox checks failed, but changes were applied. Review the errors above.
                    </p>
                  ) : debugSandboxChecks.lint.status === 'passed' && debugSandboxChecks.tests.status === 'passed' && (!debugSandboxChecks.run || debugSandboxChecks.run.status === 'passed') ? (
                    <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                      ✓ All checks passed. Application verified working. Changes have been applied to your workspace.
                    </p>
                  ) : debugSandboxChecks.run && debugSandboxChecks.run.status === 'passed' ? (
                    <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                      ✓ Application runs successfully. Changes have been applied to your workspace.
                    </p>
                  ) : (
                    <p className="text-muted-foreground mt-1 italic text-[11px]">
                      Sandbox checks skipped/not configured. Changes have been applied to your workspace.
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="text-xs">
              <p className="font-medium text-muted-foreground mb-1">What I changed:</p>
              <ul className="list-disc list-inside space-y-0.5 text-foreground">
                {debugReviewSteps.map((s) => (
                  <li key={s.path}>
                    <span className="font-mono">{s.path}</span>
                    {s.description ? ` — ${s.description}` : ""}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  if (debugSelectedPaths.size === debugReviewSteps.length) {
                    setDebugSelectedPaths(new Set());
                  } else {
                    setDebugSelectedPaths(new Set(debugReviewSteps.map((s) => s.path)));
                  }
                }}
              >
                {debugSelectedPaths.size === debugReviewSteps.length ? "Deselect all" : "Select all"}
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={applyDebugSelected}
                disabled={debugApplying || debugSelectedPaths.size === 0}
              >
                {debugApplying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1" />
                    Apply selected ({debugSelectedPaths.size})
                  </>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setDebugReviewSteps([]);
                  setDebugSummary(null);
                  setDebugRootCause(null);
                  setDebugSelectedPaths(new Set());
                  setDebugFromLogMeta(null);
                }}
              >
                Discard
              </Button>
            </div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {debugReviewSteps.map((step) => (
                <div
                  key={step.path}
                  className="rounded-lg border border-border bg-background overflow-hidden"
                >
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
                    onClick={() =>
                      setDebugExpandedPath((p) => (p === step.path ? null : step.path))
                    }
                  >
                    <input
                      type="checkbox"
                      checked={debugSelectedPaths.has(step.path)}
                      onChange={(e) => {
                        e.stopPropagation();
                        setDebugSelectedPaths((prev) => {
                          const next = new Set(prev);
                          if (next.has(step.path)) next.delete(step.path);
                          else next.add(step.path);
                          return next;
                        });
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="rounded border-border"
                    />
                    {debugExpandedPath === step.path ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="truncate">{step.path}</span>
                  </button>
                  {debugExpandedPath === step.path && (
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
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area pinned to bottom so no blank space below */}
      <div className="shrink-0 border-t border-border bg-background p-2 space-y-2">
        {noWorkspaceErrorLogNote && (
          <p className="text-xs text-muted-foreground italic">
            These look like runtime logs. Select a workspace if you want me to apply code fixes; otherwise I&apos;ll just explain the error.
          </p>
        )}
        {logAttachment && useDebugForLogs && workspaceId && (
          <div className="text-xs text-muted-foreground">
            Log detected – will run <strong>Debug-from-log</strong> on this workspace.
          </div>
        )}
        {logAttachment && (
          <div className="inline-flex items-center gap-2 rounded bg-slate-800 px-2 py-1 text-xs text-slate-100 dark:bg-slate-700">
            <span>
              🖥 {logAttachment.source ?? "log"} ({logAttachment.lineCount} lines)
            </span>
            <button
              type="button"
              onClick={() => setLogAttachment(null)}
              className="text-slate-300 hover:text-slate-100"
              aria-label="Remove log"
            >
              ×
            </button>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={useDebugForLogs}
            onChange={() => {
              setUseDebugForLogs((prev) => {
                const next = !prev;
                if (typeof window !== "undefined") {
                  window.localStorage.setItem("useDebugForLogs", String(next));
                }
                return next;
              });
            }}
            className="rounded border-border"
          />
          Use Debug-from-log for pasted logs
        </label>
        {(selection?.text || tab) && (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5"
            onClick={handleExplain}
            disabled={loading}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Explain this
          </Button>
        )}
        {errorLogConfirmOpen && pendingLogMessage !== null && workspaceId && (
          <div className="rounded-lg border border-border bg-muted/50 p-3 space-y-2">
            <p className="text-sm text-foreground">
              These look like runtime logs. Do you want me to debug them against workspace{" "}
              <strong>{workspaceLabel?.name ?? "this workspace"}</strong>?
            </p>
            {workspaceIdWhenLogPasted != null && workspaceIdWhenLogPasted !== workspaceId && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Note: you changed the active workspace after sending these logs. I&apos;ll debug against{" "}
                <strong>{workspaceLabel?.name ?? "this workspace"}</strong>.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  const msg = pendingLogMessage;
                  setErrorLogConfirmOpen(false);
                  setPendingLogMessage(null);
                  setWorkspaceIdWhenLogPasted(null);
                  if (msg) runDebugFromLog(workspaceId, msg);
                }}
              >
                Debug this workspace
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setErrorLogConfirmOpen(false);
                  sendMessage(pendingLogMessage ?? "", {
                    treatAsNormal: true,
                    skipAddingUserMessage: errorLogConfirmAlreadyHasUserMessage,
                  });
                  setPendingLogMessage(null);
                  setErrorLogConfirmAlreadyHasUserMessage(false);
                }}
              >
                Just answer generally
              </Button>
            </div>
          </div>
        )}
        {debugRetrySummary && (
          <p className="text-xs text-muted-foreground py-1">
            Attempt 1: {debugRetrySummary.attempt1 ? "tests passed" : "tests failed"}. Attempt 2: {debugRetrySummary.attempt2 ? "tests passed" : "tests failed"}.
          </p>
        )}
        {showDebugFeedback && (
          <FeedbackPrompt
            source="debug"
            workspaceId={workspaceId}
            onSubmitted={() => { setShowDebugFeedback(false); setDebugRetrySummary(null); }}
            className="py-1"
          />
        )}
        <form
          className="flex gap-2"
          onKeyDown={(e) => {
            // When log is attached, let form submit handle (debug-from-log)
            if (logAttachment && e.key === "Enter" && !e.shiftKey) return;
            // Handle slash commands on Enter
            if (e.key === "Enter" && !e.shiftKey && input.trim().startsWith("/")) {
              e.preventDefault();
              const expanded = handleSlashCommand(input);
              if (expanded) {
                setInput(expanded);
                sendMessage(expanded);
              } else {
                sendMessage(input);
              }
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const content = input.trim();
            const hasLog = !!logAttachment;
            const canSend = content || hasLog;
            if (!canSend || loading) return;

            const shouldDebug = hasLog && useDebugForLogs && workspaceId;
            const textToSend = content || (hasLog ? logAttachment!.fullText : "");

            if (shouldDebug && logAttachment) {
              runDebugFromLog(workspaceId, logAttachment.fullText, {
                userMessageContent: content || "Debug this error log.",
                logAttachment,
              });
              setInput("");
              setLogAttachment(null);
              return;
            }

            if (!workspaceId) {
              sendMessage(textToSend, { prependNoWorkspaceNote: true });
            } else if (hasLog) {
              sendMessage(textToSend, { treatAsNormal: true });
            } else {
              sendMessage(textToSend);
            }
            setInput("");
            setLogAttachment(null);
          }}
        >
          <Textarea
            ref={inputRef}
            placeholder='Ask anything… or use @codebase "query" to search. Paste terminal logs to format with line numbers.'
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.getData("text");
              const fromTerminal = e.clipboardData?.types?.includes("application/x-aiforge-terminal");
              if (fromTerminal && pasted && pasted.includes("\n")) {
                e.preventDefault();
                if (looksLikeLog(pasted)) {
                  setLogAttachment(createLogAttachment(pasted));
                  setInput((prev) => prev || "Here's the error I'm seeing.");
                } else {
                  const lines = pasted.trim().split(/\r?\n/);
                  const formatted =
                    `Terminal (lines 1-${lines.length}):\n` +
                    lines.map((l, i) => `[${i + 1}] ${l}`).join("\n");
                  const ta = e.target as HTMLTextAreaElement;
                  if (ta && typeof ta.selectionStart === "number") {
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd ?? input.length;
                    setInput(input.slice(0, start) + formatted + input.slice(end));
                  } else {
                    setInput(formatted);
                  }
                }
              } else if (pasted && looksLikeLog(pasted)) {
                e.preventDefault();
                setLogAttachment(createLogAttachment(pasted));
                setInput((prev) => prev || "Here's the error I'm seeing.");
              }
            }}
            disabled={loading}
            title={loading ? "Wait for the response to finish" : undefined}
            className="flex-1 min-h-[2.25rem] resize-y max-h-32"
            rows={1}
          />
          <Button
            type="submit"
            size="icon"
            disabled={loading || (!input.trim() && !logAttachment)}
            title={
              loading
                ? "Sending…"
                : !input.trim() && !logAttachment
                  ? "Enter a message or paste logs"
                  : "Send message"
            }
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </form>
      </div>

      <Dialog
        open={debugProtectedConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDebugProtectedConfirmOpen(false);
            setDebugPendingStepsForProtected(null);
            setDebugProtectedPathsList([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{COPY.safety.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {COPY.safety.body(debugProtectedPathsList)}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDebugProtectedConfirmOpen(false);
                setDebugPendingStepsForProtected(null);
                setDebugProtectedPathsList([]);
                setError("Skipped.");
              }}
            >
              {COPY.safety.cancel}
            </Button>
            <Button
              onClick={() => {
                if (debugPendingStepsForProtected) {
                  applyDebugEdits(debugPendingStepsForProtected, debugProtectedPathsList);
                  setDebugPendingStepsForProtected(null);
                  setDebugProtectedPathsList([]);
                  setDebugProtectedConfirmOpen(false);
                }
              }}
              disabled={debugApplying}
            >
              {debugApplying ? COPY.debug.applying : COPY.safety.allow}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={debugLargeConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDebugLargeConfirmOpen(false);
            setDebugPendingStepsForApply(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm large change</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will change {debugLargeCount} file(s). Continue?
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDebugLargeConfirmOpen(false);
                setDebugPendingStepsForApply(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (debugPendingStepsForApply) {
                  applyDebugEdits(debugPendingStepsForApply);
                  setDebugPendingStepsForApply(null);
                  setDebugLargeConfirmOpen(false);
                }
              }}
              disabled={debugApplying}
            >
              {debugApplying ? COPY.debug.applying : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={prAnalyzeOpen} onOpenChange={(o) => { setPrAnalyzeOpen(o); if (!o) setPrAnalyzeResult(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Analyze PR diff</DialogTitle>
          </DialogHeader>
          {!prAnalyzeResult ? (
            <>
              <p className="text-sm text-muted-foreground">Paste a pull request diff (patch) to get a summary, risks, and suggested fixes or tests.</p>
              <Textarea
                placeholder="Paste diff here (e.g. from git diff or GitHub PR Files)..."
                value={prAnalyzeDiff}
                onChange={(e) => setPrAnalyzeDiff(e.target.value)}
                className="min-h-[200px] font-mono text-xs"
                disabled={prAnalyzeLoading}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setPrAnalyzeOpen(false)}>Cancel</Button>
                <Button
                  disabled={!prAnalyzeDiff.trim() || prAnalyzeLoading}
                  onClick={async () => {
                    setPrAnalyzeLoading(true);
                    setPrAnalyzeResult(null);
                    try {
                      const res = await fetch("/api/pr/analyze", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ diffText: prAnalyzeDiff.trim(), workspaceId: workspaceId ?? undefined }),
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error ?? "Analysis failed");
                      setPrAnalyzeResult({ summary: data.summary ?? "", risks: data.risks ?? [], suggestions: data.suggestions ?? [] });
                    } catch (e) {
                      setPrAnalyzeResult({
                        summary: "",
                        risks: [e instanceof Error ? e.message : "Analysis failed"],
                        suggestions: [],
                      });
                    } finally {
                      setPrAnalyzeLoading(false);
                    }
                  }}
                >
                  {prAnalyzeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Analyze"}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="space-y-3 text-sm">
                {prAnalyzeResult.summary && <p><span className="font-medium">Summary:</span> {prAnalyzeResult.summary}</p>}
                {prAnalyzeResult.risks.length > 0 && (
                  <div>
                    <p className="font-medium mb-1">Risks</p>
                    <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">{prAnalyzeResult.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </div>
                )}
                {prAnalyzeResult.suggestions.length > 0 && (
                  <div>
                    <p className="font-medium mb-1">Suggestions</p>
                    <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">{prAnalyzeResult.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setPrAnalyzeResult(null); setPrAnalyzeDiff(""); }}>New analysis</Button>
                <Button onClick={() => setPrAnalyzeOpen(false)}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
