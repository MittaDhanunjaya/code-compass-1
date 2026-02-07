"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { Loader2, Play, Check, X, FileEdit, Terminal, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/lib/editor-context";
import { useTerminal } from "@/lib/terminal-context";
import { PROVIDERS, PROVIDER_LABELS, OPENROUTER_FREE_MODELS, type ProviderId, type OpenRouterModelId } from "@/lib/llm/providers";
import type { AgentPlan, PlanStep, AgentLogEntry, AgentExecuteResult } from "@/lib/agent/types";
import { SAFE_EDIT_MAX_FILES } from "@/lib/protected-paths";
import type { AgentEvent } from "@/lib/agent-events";
import { openFileInWorkspace } from "@/lib/open-file-in-workspace";
import { useWorkspaceLabel } from "@/lib/use-workspace-label";

type AgentPhase = "idle" | "loading_plan" | "plan_ready" | "executing" | "done";

type AgentPanelProps = {
  workspaceId: string | null;
};

export function AgentPanel({ workspaceId }: AgentPanelProps) {
  const { getTab, updateContent, openFile, setActiveTab } = useEditor();
  const { addLog } = useTerminal();
  const workspaceLabel = useWorkspaceLabel(workspaceId);
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<AgentPhase>("idle");
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [executeResult, setExecuteResult] = useState<AgentExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Load provider and model from localStorage, default to openrouter + deepseek-coder:free
  const getStoredProvider = (): ProviderId => {
    if (typeof window === "undefined") return "openrouter";
    const key = workspaceId ? `agent-provider-${workspaceId}` : "agent-provider-default";
    const stored = localStorage.getItem(key);
    return (stored && PROVIDERS.includes(stored as ProviderId)) ? (stored as ProviderId) : "openrouter";
  };

  const getStoredModel = (): string => {
    if (typeof window === "undefined") return "openrouter/free";
    const key = workspaceId ? `agent-model-${workspaceId}` : "agent-model-default";
    const stored = localStorage.getItem(key);
    const m = stored || "openrouter/free";
    if (m === "deepseek/deepseek-coder:free" || m === "deepseek/deepseek-r1:free") return "openrouter/free";
    return m;
  };
  
  const [provider, setProviderState] = useState<ProviderId>(getStoredProvider());
  const [model, setModelState] = useState<string>(getStoredModel());
  const [planUsage, setPlanUsage] = useState<string | null>(null);
  const [largeFileConfirmOpen, setLargeFileConfirmOpen] = useState(false);
  const [largeFileCount, setLargeFileCount] = useState(0);
  const [protectedConfirmOpen, setProtectedConfirmOpen] = useState(false);
  const [protectedPathsList, setProtectedPathsList] = useState<string[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [runSummary, setRunSummary] = useState<{
    editedFiles: Set<string>;
    filesSkippedDueToConflict: Set<string>;
    commandsRun: string[];
    reasoningCount: number;
    toolCallCount: number;
    toolResultCount: number;
    statusCount: number;
    isComplete: boolean;
    wasCancelled: boolean;
  } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const eventsEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [agentEvents]);

  // Persist provider selection
  const setProvider = useCallback((newProvider: ProviderId) => {
    setProviderState(newProvider);
    if (typeof window !== "undefined") {
      const key = workspaceId ? `agent-provider-${workspaceId}` : "agent-provider-default";
      localStorage.setItem(key, newProvider);
      // Reset model to default if switching away from OpenRouter
      if (newProvider !== "openrouter") {
        const modelKey = workspaceId ? `agent-model-${workspaceId}` : "agent-model-default";
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
      const key = workspaceId ? `agent-model-${workspaceId}` : "agent-model-default";
      localStorage.setItem(key, newModel);
    }
  }, [workspaceId]);

  // Update provider/model when workspace changes
  useEffect(() => {
    setProviderState(getStoredProvider());
    setModelState(getStoredModel());
  }, [workspaceId]);

  const fetchFileList = useCallback(async (): Promise<string[]> => {
    if (!workspaceId) return [];
    const res = await fetch(`/api/workspaces/${workspaceId}/files`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map((f: { path: string }) => f.path) : [];
  }, [workspaceId]);

  const startPlan = useCallback(async () => {
    if (!instruction.trim() || !workspaceId || phase !== "idle") return;
    setError(null);
    setPlanUsage(null);
    setAgentEvents([]);
    setRunSummary(null);
    setPhase("loading_plan");
    
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    try {
      const fileList = await fetchFileList();
      const res = await fetch("/api/agent/plan-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: instruction.trim(),
          workspaceId,
          provider,
          model: provider === "openrouter" ? model : undefined,
          fileList,
          useIndex: true,
        }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: "Plan failed" }));
        throw new Error(errorData.error || "Plan failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response body");

      let buffer = "";
      let finalPlan: AgentPlan | null = null;
      let finalUsage: any = null;
      let lastStatusMessage: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "plan") {
                finalPlan = data.plan;
                finalUsage = data.usage;
              } else if (data.id && data.type && data.message) {
                const event = data as AgentEvent;
                if (event.type === "status" && typeof event.message === "string" && (event.message.startsWith("Error:") || event.message.includes("valid") || event.message.includes("JSON"))) {
                  lastStatusMessage = event.message;
                }
                setAgentEvents((prev) => [...prev, event]);
                
                // Update run summary aggregates
                setRunSummary((prev) => {
                  const summary = prev || {
                    editedFiles: new Set<string>(),
                    commandsRun: [],
                    reasoningCount: 0,
                    toolCallCount: 0,
                    toolResultCount: 0,
                    statusCount: 0,
                    isComplete: false,
                    wasCancelled: false,
                  };
                  
                  // Count by type
                  if (event.type === "reasoning") summary.reasoningCount++;
                  else if (event.type === "tool_call") summary.toolCallCount++;
                  else if (event.type === "tool_result") summary.toolResultCount++;
                  else if (event.type === "status") summary.statusCount++;
                  
                  // Track edited files (from tool_result events with filePath)
                  if (event.type === "tool_result" && event.meta?.filePath) {
                    summary.editedFiles.add(event.meta.filePath);
                  }
                  
                  // Track commands (from tool_call events with command)
                  if (event.type === "tool_call" && event.meta?.command) {
                    if (!summary.commandsRun.includes(event.meta.command)) {
                      summary.commandsRun.push(event.meta.command);
                    }
                  }
                  
                  return { ...summary };
                });
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }

      if (finalPlan && finalPlan.steps?.length) {
        setPlan(finalPlan);
        if (finalUsage) {
          const u = finalUsage as {
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
          if (provider === "openai" && u.inputTokens != null && u.outputTokens != null) {
            const inputCost = (u.inputTokens / 1_000_000) * 0.15;
            const outputCost = (u.outputTokens / 1_000_000) * 0.6;
            const totalCost = inputCost + outputCost;
            if (totalCost > 0.0001) {
              parts.push(`Est. cost: $${totalCost.toFixed(4)}`);
            }
          }
          if (parts.length > 0) {
            setPlanUsage(parts.join(" • "));
          }
        }
        setPhase("plan_ready");
      } else {
        if (finalPlan && (!finalPlan.steps || finalPlan.steps.length === 0)) {
          throw new Error("Empty plan returned: The agent couldn't generate any steps. Try:\n- Including specific file paths in your error description\n- Being more explicit about what needs to be fixed\n- Checking if the files mentioned in errors exist in the workspace");
        }
        const detail = lastStatusMessage ?? "Check the activity feed above for details.";
        throw new Error(`Empty plan returned: The agent didn't return a valid plan. ${detail}`);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        const cancelEvent: AgentEvent = {
          id: `${Date.now()}`,
          type: "status",
          message: "Run cancelled by user",
          createdAt: new Date().toISOString(),
        };
        setAgentEvents((prev) => [...prev, cancelEvent]);
        setRunSummary((prev) => prev ? { ...prev, isComplete: true, wasCancelled: true } : {
          editedFiles: new Set<string>(),
          commandsRun: [],
          reasoningCount: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          statusCount: 1,
          isComplete: true,
          wasCancelled: true,
        });
        setPhase("idle");
        return;
      }
      const errorMsg = e instanceof Error ? e.message : "Plan failed";
      if (errorMsg.includes("No API key configured") && provider === "openrouter") {
        setError(`OpenRouter: No API key configured. Click 'Get free key' in API Keys settings to set it up.`);
      } else {
        let msg = errorMsg.includes(PROVIDER_LABELS[provider]) ? errorMsg : `${PROVIDER_LABELS[provider]}: ${errorMsg}`;
        if (errorMsg.toLowerCase().includes("not a valid model") || errorMsg.includes("invalid model")) {
          msg += " If you use an OpenAI key, switch the Provider dropdown above to \"OpenAI\".";
        }
        setError(msg);
      }
      setPhase("idle");
    } finally {
      abortControllerRef.current = null;
    }
  }, [instruction, workspaceId, provider, model, phase, fetchFileList]);

  const rejectPlan = useCallback(() => {
    setPlan(null);
    setPhase("idle");
    setError(null);
  }, []);

  const doExecute = useCallback(
    async (confirmedProtectedPaths?: string[], skipProtected?: boolean) => {
      if (!plan || !workspaceId) return;
      setError(null);
      setAgentEvents([]);
      setRunSummary(null); // Reset summary for new execution
      setPhase("executing");
      
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      
      try {
        const res = await fetch("/api/agent/execute-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            plan,
            provider,
            model: provider === "openrouter" ? model : undefined,
            confirmedProtectedPaths: confirmedProtectedPaths ?? undefined,
            skipProtected: skipProtected === true,
          }),
          signal: abortController.signal,
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({ error: "Execute failed" }));
          throw new Error(errorData.error || "Execute failed");
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error("No response body");

        let buffer = "";
        let finalResult: AgentExecuteResult | null = null;

        while (true) {
          const { done, value } = await reader.read();
          
          if (value) {
            buffer += decoder.decode(value, { stream: true });
          }
          
          // Process complete lines (ending with \n)
          const lines = buffer.split("\n");
          // Keep the last incomplete line in buffer
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.trim() && line.startsWith("data: ")) {
              try {
                const jsonStr = line.slice(6).trim();
                if (!jsonStr) continue;
                
                const data = JSON.parse(jsonStr);
                if (data.type === "result") {
                  finalResult = data.result;
                } else if (data.type === "needProtectedConfirmation") {
                  setProtectedPathsList(data.protectedPaths || []);
                  setProtectedConfirmOpen(true);
                  setPhase("plan_ready");
                  abortControllerRef.current = null;
                  return;
                } else if (data.id && data.type && data.message) {
                  // AgentEvent - track for summary
                  const event = data as AgentEvent;
                  setAgentEvents((prev) => [...prev, event]);
                  
                  // Update run summary aggregates
                  setRunSummary((prev) => {
                    const summary = prev || {
                      editedFiles: new Set<string>(),
                      filesSkippedDueToConflict: new Set<string>(),
                      commandsRun: [],
                      reasoningCount: 0,
                      toolCallCount: 0,
                      toolResultCount: 0,
                      statusCount: 0,
                      isComplete: false,
                      wasCancelled: false,
                    };
                    
                    // Count by type
                    if (event.type === "reasoning") summary.reasoningCount++;
                    else if (event.type === "tool_call") summary.toolCallCount++;
                    else if (event.type === "tool_result") summary.toolResultCount++;
                    else if (event.type === "status") summary.statusCount++;
                    
                    // Track edited files vs skipped (conflict) from tool_result with filePath
                    if (event.type === "tool_result" && event.meta?.filePath) {
                      if (event.meta.conflict) {
                        summary.filesSkippedDueToConflict.add(event.meta.filePath);
                      } else {
                        summary.editedFiles.add(event.meta.filePath);
                      }
                    }
                    
                    // Track commands (from tool_call events with command)
                    if (event.type === "tool_call" && event.meta?.command) {
                      if (!summary.commandsRun.includes(event.meta.command)) {
                        summary.commandsRun.push(event.meta.command);
                      }
                    }
                    
                    // Check for completion status
                    if (event.type === "status" && (
                      event.message.toLowerCase().includes("complete") ||
                      event.message.toLowerCase().includes("finished") ||
                      event.message.toLowerCase().includes("done")
                    )) {
                      summary.isComplete = true;
                    }
                    
                    return { ...summary };
                  });
                }
              } catch (e) {
                // Skip invalid JSON - log for debugging
                console.warn("Failed to parse SSE line:", line.slice(0, 100), e);
              }
            }
          }
          
          if (done) {
            // Process any remaining buffer when stream ends
            if (buffer.trim() && buffer.startsWith("data: ")) {
              try {
                const jsonStr = buffer.slice(6).trim();
                if (jsonStr) {
                  const data = JSON.parse(jsonStr);
                  if (data.type === "result") {
                    finalResult = data.result;
                  } else if (data.id && data.type && data.message) {
                    const event = data as AgentEvent;
                    setAgentEvents((prev) => [...prev, event]);
                    
                    // Update summary for final event
                    setRunSummary((prev) => {
                      if (!prev) return null;
                      const summary = { ...prev };
                      if (event.type === "reasoning") summary.reasoningCount++;
                      else if (event.type === "tool_call") summary.toolCallCount++;
                      else if (event.type === "tool_result") {
                        summary.toolResultCount++;
                        if (event.meta?.filePath) {
                          if (event.meta.conflict) summary.filesSkippedDueToConflict.add(event.meta.filePath);
                          else summary.editedFiles.add(event.meta.filePath);
                        }
                      }
                      else if (event.type === "status") summary.statusCount++;
                      return summary;
                    });
                  }
                }
              } catch (e) {
                console.warn("Failed to parse final buffer:", buffer.slice(0, 200), e);
              }
            }
            break;
          }
        }

        if (!finalResult) {
          // Log what we received for debugging
          console.error("No result received. Events:", agentEvents.length, "Last events:", agentEvents.slice(-3));
          console.error("Remaining buffer:", buffer.slice(0, 500));
          throw new Error("No result received from execution stream. Check console for details.");
        }

        setExecuteResult(finalResult);
        
        // Mark execution as complete; merge filesSkippedDueToConflict from result if present
        const skippedFromResult = (finalResult as { filesSkippedDueToConflict?: string[] }).filesSkippedDueToConflict;
        setRunSummary((prev) => {
          if (!prev) return null;
          const next = { ...prev, isComplete: true };
          if (Array.isArray(skippedFromResult) && skippedFromResult.length > 0) {
            next.filesSkippedDueToConflict = new Set([...prev.filesSkippedDueToConflict, ...skippedFromResult]);
          }
          return next;
        });

        // Log to terminal
        for (const entry of finalResult.log ?? []) {
          if (entry.type === "info") {
            addLog({ type: "info", content: entry.message || "", command: undefined });
          } else if (entry.type === "command") {
            addLog({ type: "command", content: `$ ${entry.command}`, command: entry.command });
            if (entry.commandStatusSummary) {
              addLog({
                type: entry.commandStatus === "success" ? "info" : "error",
                content: `[Status: ${entry.commandStatusSummary}]`,
                command: entry.command,
              });
            }
            const message = entry.message || "";
            const lines = message.split("\n");
            let inStdout = false;
            let inStderr = false;
            let stdoutContent = "";
            let stderrContent = "";
            for (const line of lines) {
              if (line.startsWith("stdout: ")) {
                inStdout = true;
                inStderr = false;
                stdoutContent = line.substring(8);
              } else if (line.startsWith("stderr: ")) {
                inStdout = false;
                inStderr = true;
                stderrContent = line.substring(8);
              } else if (inStdout) {
                stdoutContent += (stdoutContent ? "\n" : "") + line;
              } else if (inStderr) {
                stderrContent += (stderrContent ? "\n" : "") + line;
              } else if (line.trim()) {
                addLog({
                  type: entry.status === "ok" ? "info" : "error",
                  content: line,
                  command: entry.command,
                });
              }
            }
            if (stdoutContent) addLog({ type: "output", content: stdoutContent, command: entry.command });
            if (stderrContent) addLog({ type: "error", content: stderrContent, command: entry.command });
            if (entry.autoFixAttempted && entry.secondRunSummary) {
              addLog({
                type: entry.secondRunStatus === "success" ? "info" : "error",
                content: `[Auto-fix second run: ${entry.secondRunSummary}]`,
                command: entry.command,
              });
            }
          }
        }

        // Update files
        for (const path of finalResult.filesEdited ?? []) {
          const fileRes = await fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`);
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            const content = fileData.content ?? "";
            const tab = getTab(path);
            if (tab) updateContent(path, content);
            else openFile(path, content);
          }
        }

        setPhase("done");
        window.dispatchEvent(new CustomEvent("refresh-file-tree"));
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          const cancelEvent: AgentEvent = {
            id: `${Date.now()}`,
            type: "status",
            message: "Run cancelled by user",
            createdAt: new Date().toISOString(),
          };
          setAgentEvents((prev) => [...prev, cancelEvent]);
          setRunSummary((prev) => prev ? { ...prev, isComplete: true, wasCancelled: true } : {
            editedFiles: new Set<string>(),
            filesSkippedDueToConflict: new Set<string>(),
            commandsRun: [],
            reasoningCount: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            statusCount: 1,
            isComplete: true,
            wasCancelled: true,
          });
          setPhase("plan_ready");
          return;
        }
        setError(e instanceof Error ? e.message : "Execute failed");
        setPhase("plan_ready");
      } finally {
        abortControllerRef.current = null;
      }
    },
    [plan, workspaceId, provider, model, getTab, updateContent, openFile, addLog]
  );

  const approveAndExecute = useCallback(async () => {
    if (!plan || !workspaceId || phase !== "plan_ready") return;
    
    if (!workspaceId || typeof workspaceId !== "string" || workspaceId.trim() === "") {
      setError("Invalid workspace ID");
      return;
    }
    
    const fileEditCount = plan.steps.filter((s) => s.type === "file_edit").length;
    
    // Try to fetch workspace for safe_edit_mode check, but don't fail if it doesn't work
    // The backend will validate the workspace exists during execution
    let safeEditMode = true; // Default to safe mode
    try {
      const wsRes = await fetch(`/api/workspaces/${workspaceId}`);
      if (wsRes.ok) {
        const ws = await wsRes.json();
        if (ws && ws.id) {
          safeEditMode = ws.safe_edit_mode !== false;
        }
      } else {
        // Workspace fetch failed - log but continue (backend will validate)
        console.warn("Could not fetch workspace for safe_edit_mode check, using default (true)");
      }
    } catch (e) {
      // Workspace fetch failed - log but continue
      console.warn("Workspace fetch error, using default safe_edit_mode:", e);
    }
    
    // Check file count threshold
    if (safeEditMode && fileEditCount > SAFE_EDIT_MAX_FILES) {
      setLargeFileCount(fileEditCount);
      setLargeFileConfirmOpen(true);
      return;
    }
    
    // Proceed with execution - backend will validate workspace exists
    await doExecute();
  }, [plan, workspaceId, phase, doExecute]);

  const confirmLargeFileExecute = useCallback(() => {
    setLargeFileConfirmOpen(false);
    doExecute();
  }, [doExecute]);

  const confirmProtectedExecute = useCallback(() => {
    setProtectedConfirmOpen(false);
    doExecute(protectedPathsList, false);
    setProtectedPathsList([]);
  }, [protectedPathsList, doExecute]);

  const cancelProtectedExecute = useCallback(() => {
    setProtectedConfirmOpen(false);
    const paths = [...protectedPathsList];
    setProtectedPathsList([]);
    doExecute([], true);
  }, [protectedPathsList, doExecute]);

  const cancelRun = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setPlan(null);
    setExecuteResult(null);
    setPhase("idle");
    setError(null);
    setAgentEvents([]);
    setRunSummary(null);
  }, []);

  const handleFileClick = useCallback(
    async (filePath: string, preferDiff = true) => {
      if (!workspaceId) return;
      await openFileInWorkspace({
        path: filePath,
        preferDiff,
        workspaceId,
        openFile,
        getTab,
        updateContent,
        setActiveTab,
      });
    },
    [workspaceId, openFile, getTab, updateContent, setActiveTab]
  );

  if (!workspaceId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-4 text-sm text-muted-foreground">
        <p>Open a workspace to use the Agent</p>
      </div>
    );
  }

  const hasErrors = executeResult?.log?.some((e) => e.status === "error");
  const statusPillLabel =
    phase === "loading_plan"
      ? "Planning"
      : phase === "plan_ready"
        ? "Plan ready"
        : phase === "executing"
          ? "Running plan…"
          : phase === "done"
            ? hasErrors
              ? "Failed"
              : "Completed"
            : "Idle";

  const workspaceLabelText = workspaceLabel
    ? `Workspace: ${workspaceLabel.name}${workspaceLabel.branch ? ` (${workspaceLabel.branch})` : ""}`
    : "Workspace: …";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <p className="text-xs font-medium text-muted-foreground truncate" title={workspaceLabelText}>
          {workspaceLabelText}
        </p>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              phase === "loading_plan" || phase === "executing"
                ? "bg-primary/15 text-primary"
                : phase === "done"
                  ? hasErrors
                    ? "bg-destructive/15 text-destructive"
                    : "bg-green-500/15 text-green-700 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {statusPillLabel}
          </span>
          {(phase === "loading_plan" || phase === "executing") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={cancelRun}
            >
              <XCircle className="h-3 w-3 mr-1" />
              Cancel
            </Button>
          )}
          <span className="text-xs text-muted-foreground">Provider:</span>
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
        </div>
        {provider === "openrouter" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs font-medium">
                {OPENROUTER_FREE_MODELS.find((m) => m.id === model)?.label || model} ▼
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
        )}
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto p-3 space-y-3">
        {/* Instruction + Start */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            Instruction
          </label>
          <Textarea
            placeholder="e.g. Add a README with setup instructions"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={phase !== "idle" && phase !== "done"}
            className="min-h-[80px] resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                startPlan();
              }
            }}
          />
          <Button
            className="w-full gap-2"
            onClick={startPlan}
            disabled={
              !instruction.trim() ||
              phase === "loading_plan" ||
              phase === "executing"
            }
          >
            {phase === "loading_plan" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Planning…
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Start
              </>
            )}
          </Button>
        </div>

        {error && (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Plan review */}
        {phase === "plan_ready" && plan && (
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium">
                Plan ({plan.steps.length} steps) • {PROVIDER_LABELS[provider]}
              </span>
              {planUsage && (
                <span className="rounded bg-background/60 px-2 py-0.5">
                  {planUsage}
                </span>
              )}
            </div>
            {plan.summary && (
              <p className="text-sm text-muted-foreground">{plan.summary}</p>
            )}
            <ul className="space-y-1.5 text-sm">
              {plan.steps.map((step: PlanStep, i: number) => (
                <li key={i} className="flex items-start gap-2">
                  {step.type === "file_edit" ? (
                    <FileEdit className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                  ) : (
                    <Terminal className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                  )}
                  <span>
                    {step.type === "file_edit"
                      ? step.path
                      : step.command}
                    {step.description && (
                      <span className="text-muted-foreground">
                        {" "}
                        — {step.description}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2 pt-2">
              <Button size="sm" className="gap-1" onClick={approveAndExecute}>
                <Check className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1"
                onClick={rejectPlan}
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
          </div>
        )}

        {/* Agent Activity Feed - Shows real-time agent thinking and tool usage */}
        {(phase === "loading_plan" || phase === "executing" || (phase === "done" && agentEvents.length > 0)) && agentEvents.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">Agent activity</div>
              <div className="text-[10px] text-muted-foreground">
                {agentEvents.length} event{agentEvents.length !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1.5 text-xs font-mono">
              {agentEvents.map((event) => {
                const labelMap: Record<AgentEvent['type'], string> = {
                  reasoning: "Thinking",
                  tool_call: "Tool",
                  tool_result: "Result",
                  status: "Status",
                };
                const label = labelMap[event.type] || event.type;
                const colorMap: Record<AgentEvent['type'], string> = {
                  reasoning: "text-blue-600 dark:text-blue-400",
                  tool_call: "text-purple-600 dark:text-purple-400",
                  tool_result: "text-green-600 dark:text-green-400",
                  status: "text-muted-foreground",
                };
                const iconMap: Record<AgentEvent['type'], string> = {
                  reasoning: "💭",
                  tool_call: "🔧",
                  tool_result: "✓",
                  status: "ℹ",
                };
                return (
                  <div key={event.id} className="flex items-start gap-2 py-0.5">
                    <span className={`shrink-0 font-medium ${colorMap[event.type] || "text-muted-foreground"}`}>
                      {iconMap[event.type]} [{label}]
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground break-words">{event.message}</div>
                      {event.meta?.filePath && (
                        <div className="text-muted-foreground font-mono text-[10px] mt-0.5 opacity-75">
                          📄{" "}
                          <button
                            onClick={() => handleFileClick(event.meta!.filePath!)}
                            className="underline hover:text-foreground transition-colors cursor-pointer"
                            title="Open this file"
                          >
                            {event.meta.filePath}
                          </button>
                        </div>
                      )}
                      {event.meta?.command && (
                        <div className="text-muted-foreground font-mono text-[10px] mt-0.5 opacity-75">
                          $ {event.meta.command}
                        </div>
                      )}
                      {event.meta?.toolName && !event.meta.filePath && !event.meta.command && (
                        <div className="text-muted-foreground text-[10px] mt-0.5 opacity-75">
                          Tool: {event.meta.toolName}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={eventsEndRef} />
            </div>
            
            {/* Run Summary - shown when execution is complete or cancelled */}
            {runSummary && runSummary.isComplete && (phase === "done" || (phase === "plan_ready" && runSummary.wasCancelled)) && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Run summary
                  {runSummary.wasCancelled && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">(Cancelled)</span>
                  )}
                </div>
                <div className="space-y-1.5 text-xs">
                  {runSummary.editedFiles.size > 0 && (
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground">Edited {runSummary.editedFiles.size} file(s):</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs"
                          onClick={() => {
                            const paths = Array.from(runSummary.editedFiles);
                            if (paths.length > 0) handleFileClick(paths[0], true);
                          }}
                        >
                          Review all changes
                        </Button>
                      </div>
                      <p className="text-muted-foreground text-[10px] mt-1">
                        Click any file to inspect its changes, or &quot;Review all changes&quot; to start from the first edited file.
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {Array.from(runSummary.editedFiles).slice(0, 5).map((filePath) => (
                          <button
                            key={filePath}
                            onClick={() => handleFileClick(filePath)}
                            className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-400 hover:bg-blue-500/20 transition-colors font-mono text-[10px] underline"
                            title="Open this file"
                          >
                            {filePath}
                          </button>
                        ))}
                        {runSummary.editedFiles.size > 5 && (
                          <span className="text-muted-foreground text-[10px] py-0.5">
                            +{runSummary.editedFiles.size - 5} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {(runSummary.filesSkippedDueToConflict?.size ?? 0) > 0 && (
                    <div>
                      <span className="text-muted-foreground">Needs human review (file changed since planning):</span>{" "}
                      <span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
                        {Array.from(runSummary.filesSkippedDueToConflict ?? []).slice(0, 5).join(", ")}
                        {(runSummary.filesSkippedDueToConflict?.size ?? 0) > 5 && ` +${(runSummary.filesSkippedDueToConflict?.size ?? 0) - 5} more`}
                      </span>
                    </div>
                  )}
                  {runSummary.commandsRun.length > 0 && (
                    <div>
                      <span className="text-muted-foreground">Ran {runSummary.commandsRun.length} command(s):</span>{" "}
                      <span className="font-mono text-[10px]">
                        {runSummary.commandsRun.slice(0, 3).join(", ")}
                        {runSummary.commandsRun.length > 3 && ` +${runSummary.commandsRun.length - 3} more`}
                      </span>
                    </div>
                  )}
                  <div className="text-muted-foreground text-[10px] pt-1">
                    Total events: {agentEvents.length} (
                    {runSummary.reasoningCount > 0 && `reasoning: ${runSummary.reasoningCount}`}
                    {runSummary.reasoningCount > 0 && runSummary.toolCallCount > 0 && ", "}
                    {runSummary.toolCallCount > 0 && `tools: ${runSummary.toolCallCount}`}
                    {runSummary.toolCallCount > 0 && runSummary.toolResultCount > 0 && ", "}
                    {runSummary.toolResultCount > 0 && `results: ${runSummary.toolResultCount}`}
                    )
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {phase === "executing" && agentEvents.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Running plan… (editing files, running commands, running tests)
          </div>
        )}

        {/* Execution log + summary */}
        {phase === "done" && executeResult && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <div className="text-xs font-medium text-muted-foreground">
              Execution log
            </div>
            <ul className="space-y-1 text-sm">
              {executeResult.log.map((entry: AgentLogEntry, i: number) => (
                <li
                  key={i}
                  className={`flex items-start gap-2 ${
                    entry.type === "info"
                      ? "text-muted-foreground italic"
                      : entry.status === "ok"
                        ? "text-green-700 dark:text-green-400"
                        : entry.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground"
                  }`}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    [{entry.stepIndex + 1}]
                  </span>
                  {entry.actionLabel != null && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        entry.actionLabel === "EDIT"
                          ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
                          : entry.actionLabel === "CMD-SETUP"
                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                            : entry.actionLabel === "CMD-TEST"
                              ? "bg-purple-500/15 text-purple-700 dark:text-purple-400"
                              : entry.actionLabel === "AUTO-FIX"
                                ? "bg-orange-500/15 text-orange-700 dark:text-orange-400"
                                : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {entry.actionLabel}
                    </span>
                  )}
                  <span className="min-w-0">
                    {entry.statusLine ?? entry.message}
                  </span>
                </li>
              ))}
            </ul>
            <div className="border-t border-border pt-2 text-sm">
              <div className="font-medium text-muted-foreground">
                Completion summary
              </div>
              <p className="mt-1">{executeResult.summary}</p>
              {(executeResult as any).sandboxChecks && (
                <div className="mt-2 rounded border border-border bg-muted/30 p-2 text-xs">
                  <div className="font-medium mb-1">Sandbox checks:</div>
                  <div className="space-y-1">
                    <div className="flex items-start gap-2">
                      <span>Lint:</span>
                      <div className="flex-1">
                        <span className={`font-mono ${
                          (executeResult as any).sandboxChecks.lint.status === 'passed' ? 'text-green-600 dark:text-green-400' : 
                          (executeResult as any).sandboxChecks.lint.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                          'text-muted-foreground'
                        }`}>
                          {(executeResult as any).sandboxChecks.lint.status === 'passed' ? '✓ passed' : 
                           (executeResult as any).sandboxChecks.lint.status === 'failed' ? '✗ failed' :
                           (executeResult as any).sandboxChecks.lint.status === 'skipped' ? '⊘ skipped' : '○ not configured'}
                        </span>
                        {(executeResult as any).sandboxChecks.lint.logs && (executeResult as any).sandboxChecks.lint.status === 'failed' && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-20 overflow-y-auto">
                            {(executeResult as any).sandboxChecks.lint.logs}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>Tests:</span>
                      <div className="flex-1">
                        <span className={`font-mono ${
                          (executeResult as any).sandboxChecks.tests.status === 'passed' ? 'text-green-600 dark:text-green-400' : 
                          (executeResult as any).sandboxChecks.tests.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                          'text-muted-foreground'
                        }`}>
                          {(executeResult as any).sandboxChecks.tests.status === 'passed' ? '✓ passed' : 
                           (executeResult as any).sandboxChecks.tests.status === 'failed' ? '✗ failed' :
                           (executeResult as any).sandboxChecks.tests.status === 'skipped' ? '⊘ skipped' : '○ not configured'}
                        </span>
                        {(executeResult as any).sandboxChecks.tests.logs && (executeResult as any).sandboxChecks.tests.status === 'failed' && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-20 overflow-y-auto">
                            {(executeResult as any).sandboxChecks.tests.logs}
                          </div>
                        )}
                      </div>
                    </div>
                    {(executeResult as any).sandboxChecks.run && (
                      <div className="flex items-start gap-2">
                        <span>Run:</span>
                        <div className="flex-1">
                          <span className={`font-mono ${
                            (executeResult as any).sandboxChecks.run.status === 'passed' ? 'text-green-600 dark:text-green-400' : 
                            (executeResult as any).sandboxChecks.run.status === 'failed' ? 'text-red-600 dark:text-red-400' :
                            'text-muted-foreground'
                          }`}>
                            {(executeResult as any).sandboxChecks.run.status === 'passed' ? '✓ passed' : 
                             (executeResult as any).sandboxChecks.run.status === 'failed' ? '✗ failed' :
                             (executeResult as any).sandboxChecks.run.status === 'skipped' ? '⊘ skipped' : '○ not configured'}
                          </span>
                          {(executeResult as any).sandboxChecks.run.logs && (executeResult as any).sandboxChecks.run.status === 'failed' && (
                            <div className="text-[10px] text-muted-foreground mt-0.5 font-mono max-h-20 overflow-y-auto">
                              {(executeResult as any).sandboxChecks.run.logs}
                            </div>
                          )}
                          {(executeResult as any).sandboxChecks.run.port && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              Running on port {(executeResult as any).sandboxChecks.run.port}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {(executeResult as any).sandboxChecks.run && (executeResult as any).sandboxChecks.run.status === 'failed' ? (
                      <p className="text-red-600 dark:text-red-400 mt-1 italic text-[11px] font-medium">
                        ✗ CRITICAL: Application failed to run. Changes were NOT applied. Please fix errors and try again.
                      </p>
                    ) : (executeResult as any).sandboxChecks.lint.status === 'failed' || (executeResult as any).sandboxChecks.tests.status === 'failed' ? (
                      <p className="text-amber-600 dark:text-amber-400 mt-1 italic text-[11px]">
                        Sandbox checks failed (lint/tests), but application runs. Changes were applied. Review the errors above.
                      </p>
                    ) : (executeResult as any).sandboxChecks.lint.status === 'passed' && (executeResult as any).sandboxChecks.tests.status === 'passed' && (!(executeResult as any).sandboxChecks.run || (executeResult as any).sandboxChecks.run.status === 'passed') ? (
                      <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                        ✓ All checks passed. Application verified working. Changes have been applied to your workspace.
                      </p>
                    ) : (executeResult as any).sandboxChecks.run && (executeResult as any).sandboxChecks.run.status === 'passed' ? (
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
              {executeResult.filesEdited?.length > 0 ? (
                <div className="mt-2 space-y-1">
                  <p className="font-medium text-muted-foreground">
                    Files created/modified ({executeResult.filesEdited.length}):
                  </p>
                  <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                    {executeResult.filesEdited.map((path) => (
                      <li key={path} className="font-mono text-xs">
                        {path}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    💡 Files are saved in your workspace. Check the file tree on the left (refresh if needed).
                  </p>
                </div>
              ) : (executeResult as any).sandboxChecks?.run?.status === 'failed' ? (
                <div className="mt-2 space-y-1">
                  <p className="text-red-600 dark:text-red-400 text-xs font-medium">
                    ⚠️ No changes were applied because the application failed to run. Please review the errors above and fix them before trying again.
                  </p>
                </div>
              ) : null}
            </div>
            <Button size="sm" variant="outline" onClick={reset}>
              Run again
            </Button>
          </div>
        )}
      </div>

      <Dialog open={largeFileConfirmOpen} onOpenChange={(open) => { if (!open) setLargeFileConfirmOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm large change</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This action will change {largeFileCount} file(s) in this workspace. In Safe Edit mode we recommend reviewing large changes carefully. Continue?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLargeFileConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmLargeFileExecute}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={protectedConfirmOpen} onOpenChange={(open) => { if (!open) { setProtectedConfirmOpen(false); setProtectedPathsList([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Protected files</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            You&apos;re about to change protected files: {protectedPathsList.join(", ")}. These often contain secrets or important configuration. Allow the AI to edit these files?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={cancelProtectedExecute}>
              Cancel
            </Button>
            <Button onClick={confirmProtectedExecute}>
              Allow this time
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
