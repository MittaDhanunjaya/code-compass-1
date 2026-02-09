"use client";

import { useCallback, useState, useEffect, useRef } from "react";
import { Loader2, Play, Check, X, FileEdit, Terminal, XCircle, Users, Settings2 } from "lucide-react";
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
import { PROVIDERS, PROVIDER_LABELS, OPENROUTER_FREE_MODELS, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan, PlanStep, AgentLogEntry, AgentExecuteResult } from "@/lib/agent/types";
import { SAFE_EDIT_MAX_FILES } from "@/lib/protected-paths";
import type { AgentEvent } from "@/lib/agent-events";
import { openFileInWorkspace } from "@/lib/open-file-in-workspace";
import { useWorkspaceLabel } from "@/lib/use-workspace-label";
import { ModelsManagerDialog } from "@/components/models-manager-dialog";
import { ErrorWithAction } from "@/components/error-with-action";
import { InlineEditDiffDialog } from "@/components/inline-edit-diff-dialog";

type AgentPhase = "idle" | "loading_plan" | "plan_ready" | "executing" | "done";

type ModelSelection =
  | { type: "auto" }
  | { type: "model"; modelId: string; label: string }
  | { type: "group"; modelGroupId: string; label: string };

interface AvailableModel {
  id: string;
  label: string;
  provider: string;
  modelSlug: string;
  isDefault?: boolean;
  isFree?: boolean;
  hasKey?: boolean | string;
}
interface AvailableGroup {
  id: string;
  label: string;
  description?: string;
}

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
  const [agentReviewAccepted, setAgentReviewAccepted] = useState<Set<string>>(new Set());
  const [agentReviewApplying, setAgentReviewApplying] = useState(false);
  /** Phase F: review each file in diff before apply (like Composer). Queue of { path, originalContent, newContent }. */
  const [agentReviewQueue, setAgentReviewQueue] = useState<{ path: string; originalContent: string; newContent: string }[]>([]);
  const [agentReviewIndex, setAgentReviewIndex] = useState(0);
  /** When apply-edits returns 400 (large edit blocked), offer "Apply anyway" with confirmLargeEdit. */
  const [agentLargeEditConfirmOpen, setAgentLargeEditConfirmOpen] = useState(false);
  const [pendingLargeEditEdits, setPendingLargeEditEdits] = useState<{ path: string; content: string }[]>([]);
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
  const [planContextUsed, setPlanContextUsed] = useState<string[] | null>(null);
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
  const [modelFallbackBanner, setModelFallbackBanner] = useState<{
    from: string;
    to: string;
    availableFreeModels: { id: string; label: string }[];
  } | null>(null);
  const [modelsAvailable, setModelsAvailable] = useState<{
    defaultModels: AvailableModel[];
    userModels: (AvailableModel & { id?: string; modelId: string; enabled: boolean })[];
    groups: AvailableGroup[];
  } | null>(null);
  const [modelSelection, setModelSelectionState] = useState<ModelSelection>({ type: "auto" });
  const [modelsManagerOpen, setModelsManagerOpen] = useState(false);
  const [defaultGroupInfo, setDefaultGroupInfo] = useState<{
    groupId: string | null;
    isUserSaved: boolean;
    label?: string;
    members: { modelId: string; label: string; role: string }[];
  } | null>(null);
  const [defaultGroupSaving, setDefaultGroupSaving] = useState(false);
  const [rulesFile, setRulesFile] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const eventsEndRef = useRef<HTMLDivElement | null>(null);

  const modelSelectionStorageKey = workspaceId ? `agent-model-selection-${workspaceId}` : "agent-model-selection-default";
  const setModelSelection = useCallback(
    (sel: ModelSelection) => {
      setModelSelectionState(sel);
      if (typeof window !== "undefined") {
        localStorage.setItem(modelSelectionStorageKey, JSON.stringify(sel));
      }
    },
    [modelSelectionStorageKey]
  );

  useEffect(() => {
    const key = workspaceId ? `agent-model-selection-${workspaceId}` : "agent-model-selection-default";
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as ModelSelection;
        if (parsed?.type === "model" && parsed.modelId && parsed.label) setModelSelectionState(parsed);
        else if (parsed?.type === "group" && parsed.modelGroupId && parsed.label) setModelSelectionState(parsed);
      }
    } catch {
      // ignore
    }
  }, [workspaceId]);

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/available")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setModelsAvailable(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsManagerOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/default-group")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.members) setDefaultGroupInfo(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelsManagerOpen, modelSelection.type]);

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
    setPlanContextUsed(null);
    setAgentEvents([]);
    setRunSummary(null);
    setModelFallbackBanner(null);
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
          ...(modelSelection.type === "model"
            ? { modelId: modelSelection.modelId }
            : modelSelection.type === "group"
              ? { modelGroupId: modelSelection.modelGroupId }
              : { provider, model: provider === "openrouter" ? model : undefined }),
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
      let finalModelFallback: { from: string; to: string } | undefined;
      let finalAvailableFreeModels: { id: string; label: string }[] | undefined;
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
                if (data.modelFallback && typeof data.modelFallback === "object" && data.modelFallback.from && data.modelFallback.to) {
                  finalModelFallback = { from: data.modelFallback.from, to: data.modelFallback.to };
                }
                if (Array.isArray(data.availableFreeModels) && data.availableFreeModels.length > 0) {
                  finalAvailableFreeModels = data.availableFreeModels.map((m: { id?: string; label?: string }) => ({ id: m?.id ?? "", label: m?.label ?? m?.id ?? "" })).filter((m: { id: string }) => m.id);
                }
                if (data.contextUsed && Array.isArray(data.contextUsed.filePaths)) {
                  setPlanContextUsed(data.contextUsed.filePaths);
                }
              } else if (data.type === "error") {
                // Handle error events from the stream
                lastStatusMessage = data.error || data.message || "Unknown error";
                setAgentEvents((prev) => [...prev, {
                  id: `${Date.now()}`,
                  type: "status",
                  message: lastStatusMessage,
                  createdAt: new Date().toISOString(),
                }]);
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

      // Validate plan structure before setting it
      if (finalPlan && finalPlan.steps && Array.isArray(finalPlan.steps) && finalPlan.steps.length > 0) {
        // Validate that steps have required fields
        const validSteps: PlanStep[] = [];
        const invalidSteps: Array<{ index: number; step: any; reason: string }> = [];
        
        finalPlan.steps.forEach((step: any, index: number) => {
          if (!step || typeof step !== "object") {
            invalidSteps.push({ index, step, reason: "Step is not an object" });
            return;
          }
          
          if (step.type === "file_edit") {
            if (!step.path || typeof step.path !== "string" || step.path.trim() === "") {
              invalidSteps.push({ index, step, reason: `Missing or empty 'path' field. Step has: ${JSON.stringify(Object.keys(step))}` });
              return;
            }
            if (!step.newContent || typeof step.newContent !== "string") {
              invalidSteps.push({ index, step, reason: `Missing or invalid 'newContent' field` });
              return;
            }
            validSteps.push(step as FileEditStep);
          } else if (step.type === "command") {
            if (!step.command || typeof step.command !== "string" || step.command.trim() === "") {
              invalidSteps.push({ index, step, reason: `Missing or empty 'command' field. Step has: ${JSON.stringify(Object.keys(step))}` });
              return;
            }
            validSteps.push(step as CommandStep);
          } else {
            invalidSteps.push({ index, step, reason: `Unknown step type: ${step.type || "undefined"}` });
          }
        });
        
        if (validSteps.length === 0) {
          const errorDetails = invalidSteps.length > 0
            ? `\n\nInvalid steps details:\n${invalidSteps.map(({ index, reason, step }) => 
                `  Step ${index + 1}: ${reason}\n    Step keys: [${step && typeof step === "object" ? Object.keys(step).join(", ") : "N/A"}]\n    Step data: ${JSON.stringify(step, null, 2).slice(0, 400)}`
              ).join("\n\n")}`
            : "";
          const fullPlanPreview = JSON.stringify(finalPlan, null, 2).slice(0, 800);
          throw new Error(`Plan has no valid steps. All ${finalPlan.steps.length} step(s) are missing required fields.${errorDetails}\n\nFull plan preview:\n${fullPlanPreview}`);
        }
        
        // Log invalid steps but continue with valid ones
        if (invalidSteps.length > 0) {
          console.warn(`Plan has ${invalidSteps.length} invalid step(s) out of ${finalPlan.steps.length} total:`, invalidSteps);
        }
        
        // Use validated steps
        const validatedPlan: AgentPlan = {
          ...finalPlan,
          steps: validSteps,
        };
        
        setPlan(validatedPlan);
        if (finalModelFallback) {
          setModelFallbackBanner({
            from: finalModelFallback.from,
            to: finalModelFallback.to,
            availableFreeModels: finalAvailableFreeModels ?? [],
          });
        } else {
          setModelFallbackBanner(null);
        }
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
      if (errorMsg.includes("No API key configured")) {
        // Enhanced error message with helpful links
        if (errorMsg.includes("OpenRouter") || errorMsg.includes("openrouter")) {
          setError(`No API key configured. Get a free OpenRouter key at https://openrouter.ai/keys and add it in Settings → API Keys.`);
        } else if (errorMsg.includes("Recommended")) {
          // Use the improved error message from backend
          setError(errorMsg);
        } else {
          setError(`${errorMsg} Add an API key in Settings → API Keys. Recommended: OpenRouter (free models) or Gemini (free tier).`);
        }
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
  }, [instruction, workspaceId, provider, model, modelSelection, phase, fetchFileList]);

  const rejectPlan = useCallback(() => {
    setPlan(null);
    setPhase("idle");
    setError(null);
    setModelFallbackBanner(null);
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
            ...(modelSelection.type === "model"
              ? { modelId: modelSelection.modelId }
              : modelSelection.type === "group"
                ? { modelGroupId: modelSelection.modelGroupId }
                : { provider, model: provider === "openrouter" ? model : undefined }),
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
        const pr = (finalResult as { pendingReview?: { fileEdits: { path: string }[] } }).pendingReview;
        if (pr?.fileEdits?.length) {
          setAgentReviewAccepted(new Set(pr.fileEdits.map((e) => e.path)));
        }
        
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
    [plan, workspaceId, provider, model, modelSelection, getTab, updateContent, openFile, addLog]
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
    setAgentReviewAccepted(new Set());
    setAgentReviewApplying(false);
    setPhase("idle");
    setError(null);
    setAgentEvents([]);
    setRunSummary(null);
  }, []);

  const rerunRequestedRef = useRef(false);
  const rerun = useCallback(() => {
    if (!instruction.trim() || !workspaceId) return;
    rerunRequestedRef.current = true;
    reset();
  }, [instruction, workspaceId, reset]);

  useEffect(() => {
    if (phase === "idle" && rerunRequestedRef.current && instruction.trim() && workspaceId) {
      rerunRequestedRef.current = false;
      startPlan();
    }
  }, [phase, instruction, workspaceId, startPlan]);

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
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5 min-w-0">
        <p className="text-xs font-medium text-muted-foreground truncate" title={workspaceLabelText}>
          {workspaceLabelText}
        </p>
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
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
          {(phase === "done" || phase === "plan_ready") && instruction.trim() && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={rerun}
            >
              <Play className="h-3 w-3 mr-1" />
              Rerun
            </Button>
          )}
          {(phase === "done" || phase === "plan_ready") && plan && plan.steps?.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => doExecute()}
              disabled={phase === "executing"}
            >
              Re-run same plan
            </Button>
          )}
          <span className="text-xs text-muted-foreground">Model:</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 text-xs font-medium min-w-[140px]">
                {modelSelection.type === "auto"
                  ? "Auto"
                  : modelSelection.type === "group"
                    ? `Group: ${modelSelection.label}`
                    : modelSelection.label}
                {" ▼"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto overflow-x-hidden min-w-[220px] max-w-[min(100vw-2rem,360px)]">
              <div className="px-2 py-1.5">
                <DropdownMenuItem onClick={() => setModelSelection({ type: "auto" })} className={modelSelection.type === "auto" ? "bg-accent" : ""}>
                  Auto (best default)
                  {modelSelection.type === "auto" && <span className="ml-2 text-xs">✓</span>}
                </DropdownMenuItem>
                {defaultGroupInfo?.members?.length ? (
                  <p className="pl-2 pr-2 pb-1.5 pt-0 text-[11px] text-muted-foreground border-b border-border/60">
                    {defaultGroupInfo.isUserSaved && defaultGroupInfo.label
                      ? `Your default: ${defaultGroupInfo.label}`
                      : defaultGroupInfo.members.map((m) => `${m.label} (${m.role})`).join(", ")}
                  </p>
                ) : null}
                {defaultGroupInfo?.isUserSaved && (
                  <DropdownMenuItem
                    className="text-muted-foreground focus:text-foreground"
                    onSelect={(e) => {
                      e.preventDefault();
                      (async () => {
                        setDefaultGroupSaving(true);
                        try {
                          const res = await fetch("/api/models/default-group", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ defaultModelGroupId: null }),
                          });
                          if (res.ok) {
                            const data = await fetch("/api/models/default-group").then((r) => (r.ok ? r.json() : null));
                            if (data?.members) setDefaultGroupInfo(data);
                          }
                        } finally {
                          setDefaultGroupSaving(false);
                        }
                      })();
                    }}
                    disabled={defaultGroupSaving}
                  >
                    Clear saved default
                  </DropdownMenuItem>
                )}
              </div>
              {modelsAvailable?.defaultModels?.length ? (
                <>
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-b">Default models</div>
                  {modelsAvailable.defaultModels.map((m) => (
                    <DropdownMenuItem
                      key={m.id}
                      onClick={() => setModelSelection({ type: "model", modelId: m.id, label: m.label })}
                      className={modelSelection.type === "model" && modelSelection.modelId === m.id ? "bg-accent" : ""}
                    >
                      {m.label}
                      {m.isFree && <span className="ml-1 text-xs text-green-600 dark:text-green-400">(free)</span>}
                      {modelSelection.type === "model" && modelSelection.modelId === m.id && <span className="ml-2 text-xs">✓</span>}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              {modelsAvailable?.userModels?.length ? (
                <>
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-b">Your models</div>
                  {modelsAvailable.userModels.filter((m) => m.enabled).map((m) => (
                    <DropdownMenuItem
                      key={m.modelId}
                      onClick={() => setModelSelection({ type: "model", modelId: m.modelId, label: m.label })}
                      className={modelSelection.type === "model" && modelSelection.modelId === m.modelId ? "bg-accent" : ""}
                    >
                      {m.label}
                      {modelSelection.type === "model" && modelSelection.modelId === m.modelId && <span className="ml-2 text-xs">✓</span>}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              {modelsAvailable?.groups?.length ? (
                <>
                  <div className="px-2 py-1 text-xs font-medium text-muted-foreground border-b flex items-center gap-1">
                    <Users className="h-3 w-3" /> Groups
                  </div>
                  {modelsAvailable.groups.map((g) => (
                    <DropdownMenuItem
                      key={g.id}
                      onClick={() => setModelSelection({ type: "group", modelGroupId: g.id, label: g.label })}
                      className={modelSelection.type === "group" && modelSelection.modelGroupId === g.id ? "bg-accent" : ""}
                    >
                      <Users className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                      {g.label}
                      {modelSelection.type === "group" && modelSelection.modelGroupId === g.id && <span className="ml-2 text-xs">✓</span>}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              {modelSelection.type === "group" && (
                <DropdownMenuItem
                  className="text-muted-foreground border-t border-border/60 mt-1 pt-1"
                  disabled={defaultGroupSaving || (defaultGroupInfo?.isUserSaved && defaultGroupInfo?.groupId === modelSelection.modelGroupId)}
                  onSelect={(e) => {
                    e.preventDefault();
                    (async () => {
                      setDefaultGroupSaving(true);
                      try {
                        const res = await fetch("/api/models/default-group", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ defaultModelGroupId: modelSelection.modelGroupId }),
                        });
                        if (res.ok) {
                          const data = await fetch("/api/models/default-group").then((r) => (r.ok ? r.json() : null));
                          if (data?.members) setDefaultGroupInfo(data);
                        }
                      } finally {
                        setDefaultGroupSaving(false);
                      }
                    })();
                  }}
                >
                  {defaultGroupInfo?.isUserSaved && defaultGroupInfo?.groupId === modelSelection.modelGroupId ? "Saved as default" : "Save as default"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setModelsManagerOpen(true)} title="Manage models & groups">
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto p-3 space-y-3">
        <p className="text-[11px] text-muted-foreground/90 flex items-center gap-1.5 flex-wrap">
          <span>Rules: {rulesFile ?? "No rules file"}</span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("open-rules-editor"))}
            className="text-primary hover:underline text-[11px]"
          >
            Edit rules
          </button>
        </p>
        {/* Instruction + Start */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            Instruction
          </label>
          <Textarea
            placeholder="e.g. Add a README with setup instructions. Paste terminal logs to format with line numbers."
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onPaste={(e) => {
              const pasted = e.clipboardData?.getData("text");
              const fromTerminal = e.clipboardData?.types?.includes("application/x-aiforge-terminal");
              if (fromTerminal && pasted && pasted.includes("\n")) {
                e.preventDefault();
                const lines = pasted.trim().split(/\r?\n/);
                const formatted =
                  `Terminal (lines 1-${lines.length}):\n` +
                  lines.map((l, i) => `[${i + 1}] ${l}`).join("\n");
                const ta = e.target as HTMLTextAreaElement;
                if (ta && typeof ta.selectionStart === "number") {
                  const start = ta.selectionStart;
                  const end = ta.selectionEnd ?? instruction.length;
                  setInstruction(instruction.slice(0, start) + formatted + instruction.slice(end));
                } else {
                  setInstruction(formatted);
                }
              }
            }}
            disabled={phase !== "idle" && phase !== "done"}
            title={phase !== "idle" && phase !== "done" ? "Finish or reset the current run to edit the task" : undefined}
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
            title={
              !instruction.trim()
                ? "Enter a task to start"
                : phase === "loading_plan" || phase === "executing"
                  ? "Wait for the current step to finish"
                  : undefined
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

        {phase === "idle" && !plan && !instruction.trim() && (
          <p className="text-xs text-muted-foreground py-2">
            Describe a task and click Start. Paste error logs from the workspace to debug. Try <kbd className="rounded border border-border bg-muted/50 px-1 font-mono text-[10px]">Cmd+K</kbd> on a selection for quick edits.
          </p>
        )}

        {error && (
          <div className="space-y-2">
            <ErrorWithAction message={error} />
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => {
                setError(null);
                if (phase === "plan_ready" && plan) {
                  approveAndExecute();
                } else if (phase === "idle" && instruction.trim()) {
                  startPlan();
                }
              }}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Rate limit fallback banner */}
        {phase === "plan_ready" && modelFallbackBanner && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  Rate limit reached — switched model
                </p>
                <p className="text-muted-foreground">
                  Daily limit was reached on <span className="font-mono text-foreground/90">{modelFallbackBanner.from}</span>. We used <span className="font-mono text-foreground/90">{modelFallbackBanner.to}</span> instead.
                </p>
                {modelFallbackBanner.availableFreeModels.length > 0 && (
                  <p className="pt-1 text-muted-foreground">
                    Other free models you can try:{" "}
                    {modelFallbackBanner.availableFreeModels.map((m) => m.label || m.id).join(", ")}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setModelFallbackBanner(null)}
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
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
            {planContextUsed && planContextUsed.length > 0 && (
              <div className="rounded bg-background/40 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground/80">Context used: </span>
                {planContextUsed.slice(0, 8).map((p) => (
                  <span key={p} className="font-mono truncate inline-block max-w-[180px] align-bottom mr-1" title={p}>{p}</span>
                ))}
                {planContextUsed.length > 8 && <span>+{planContextUsed.length - 8} more</span>}
              </div>
            )}
            {plan.summary && (
              <p className="text-sm text-muted-foreground">{plan.summary}</p>
            )}
            <ul className="space-y-1.5 text-sm">
              {plan.steps && plan.steps.length > 0 ? (
                plan.steps.map((step: PlanStep, i: number) => {
                  const stepContent = step.type === "file_edit"
                    ? (step.path || "(no path specified)")
                    : (step.command || "(no command specified)");
                  
                  return (
                    <li key={i} className="flex items-start gap-2">
                      {step.type === "file_edit" ? (
                        <FileEdit className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                      ) : (
                        <Terminal className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                      )}
                      <span className="flex-1">
                        <span className={!step.path && !step.command ? "text-destructive/70" : ""}>
                          {stepContent}
                        </span>
                        {step.description && (
                          <span className="text-muted-foreground">
                            {" "}
                            — {step.description}
                          </span>
                        )}
                        {step.type === "file_edit" && !step.path && (
                          <span className="text-destructive/70 text-xs ml-1">
                            (invalid step: missing path)
                          </span>
                        )}
                        {step.type === "command" && !step.command && (
                          <span className="text-destructive/70 text-xs ml-1">
                            (invalid step: missing command)
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })
              ) : (
                <li className="text-sm text-muted-foreground italic">
                  No steps available (plan may be malformed)
                </li>
              )}
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
                  guardrail_warning: "Guardrail",
                };
                const label = labelMap[event.type] || event.type;
                const colorMap: Record<AgentEvent['type'], string> = {
                  reasoning: "text-blue-600 dark:text-blue-400",
                  tool_call: "text-purple-600 dark:text-purple-400",
                  tool_result: "text-green-600 dark:text-green-400",
                  status: "text-muted-foreground",
                  guardrail_warning: "text-amber-600 dark:text-amber-400",
                };
                const iconMap: Record<AgentEvent['type'], string> = {
                  reasoning: "💭",
                  tool_call: "🔧",
                  tool_result: "✓",
                  status: "ℹ",
                  guardrail_warning: "⚠",
                };
                return (
                  <div key={event.id} className="flex items-start gap-2 py-0.5">
                    <span className={`shrink-0 font-medium ${colorMap[event.type] || "text-muted-foreground"}`}>
                      {iconMap[event.type]} [{label}]
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground break-words">{event.message}</div>
                      {event.meta?.modelLabel && (
                        <div className="text-muted-foreground text-[10px] mt-0.5 opacity-75">
                          Model: {event.meta.modelLabel}
                          {event.meta.modelRole && ` (${event.meta.modelRole})`}
                        </div>
                      )}
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
                    {(executeResult as any).pendingReview ? (
                      <p className="text-amber-600 dark:text-amber-400 mt-1 italic text-[11px] font-medium">
                        Review your changes below. Accept or reject each file, then click Apply accepted.
                      </p>
                    ) : (executeResult as any).sandboxChecks.run && (executeResult as any).sandboxChecks.run.status === 'failed' ? (
                      <p className="text-red-600 dark:text-red-400 mt-1 italic text-[11px] font-medium">
                        ✗ CRITICAL: Application failed to run. Changes were NOT applied. Please fix errors and try again.
                      </p>
                    ) : (executeResult as any).sandboxChecks.lint.status === 'failed' || (executeResult as any).sandboxChecks.tests.status === 'failed' ? (
                      <p className="text-amber-600 dark:text-amber-400 mt-1 italic text-[11px]">
                        Sandbox checks failed (lint/tests), but application runs. Review the errors above.
                      </p>
                    ) : (executeResult as any).sandboxChecks.lint.status === 'passed' && (executeResult as any).sandboxChecks.tests.status === 'passed' && (!(executeResult as any).sandboxChecks.run || (executeResult as any).sandboxChecks.run.status === 'passed') ? (
                      <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                        ✓ All checks passed. Application verified working. Review and apply below.
                      </p>
                    ) : (executeResult as any).sandboxChecks.run && (executeResult as any).sandboxChecks.run.status === 'passed' ? (
                      <p className="text-green-600 dark:text-green-400 mt-1 italic text-[11px]">
                        ✓ Application runs successfully. Review and apply below.
                      </p>
                    ) : (
                      <p className="text-muted-foreground mt-1 italic text-[11px]">
                        Sandbox checks skipped/not configured. Review and apply below.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {(executeResult as any).pendingReview?.fileEdits?.length > 0 && workspaceId && (
                <div className="mt-3 rounded border border-border bg-muted/20 p-2 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Review edits before applying (Phase F)</p>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="default"
                      className="text-xs"
                      onClick={() => {
                        const fileEdits = (executeResult as any).pendingReview.fileEdits as { path: string; originalContent: string; newContent: string }[];
                        setAgentReviewQueue([...fileEdits]);
                        setAgentReviewIndex(0);
                        setAgentReviewAccepted(new Set());
                      }}
                    >
                      Review each file in diff
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Or accept/reject per file below, then Apply accepted.</p>
                  <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                    {((executeResult as any).pendingReview.fileEdits as { path: string; originalContent: string; newContent: string }[]).map((edit) => (
                      <li key={edit.path} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={agentReviewAccepted.has(edit.path)}
                          onChange={() => {
                            setAgentReviewAccepted((prev) => {
                              const next = new Set(prev);
                              if (next.has(edit.path)) next.delete(edit.path);
                              else next.add(edit.path);
                              return next;
                            });
                          }}
                          className="rounded border-border"
                        />
                        <span className="font-mono truncate flex-1" title={edit.path}>{edit.path}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs"
                          onClick={() => openFile(edit.path)}
                          title="Open file"
                        >
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    size="sm"
                    className="w-full"
                    disabled={agentReviewApplying || agentReviewAccepted.size === 0}
                    onClick={async () => {
                      if (!workspaceId || agentReviewAccepted.size === 0) return;
                      const fileEdits = (executeResult as any).pendingReview.fileEdits as { path: string; originalContent: string; newContent: string }[];
                      const edits = fileEdits.filter((e) => agentReviewAccepted.has(e.path)).map((e) => ({ path: e.path, content: e.newContent }));
                      setAgentReviewApplying(true);
                      try {
                        const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ edits }),
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) {
                          if (res.status === 400 && Array.isArray(data.largeEditPaths) && data.largeEditPaths.length > 0) {
                            setPendingLargeEditEdits(edits);
                            setAgentLargeEditConfirmOpen(true);
                            return;
                          }
                          throw new Error(data.error || "Failed to apply edits");
                        }
                        for (const e of edits) {
                          updateContent(e.path, e.content);
                        }
                        setExecuteResult((prev) => {
                          if (!prev) return prev;
                          const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...edits.map((x) => x.path)] };
                          delete (next as any).pendingReview;
                          return next;
                        });
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Failed to apply edits");
                      } finally {
                        setAgentReviewApplying(false);
                      }
                    }}
                  >
                    {agentReviewApplying ? "Applying…" : `Apply accepted (${agentReviewAccepted.size})`}
                  </Button>
                </div>
              )}
              {executeResult.filesEdited?.length > 0 && !(executeResult as any).pendingReview ? (
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
            <Button size="sm" variant="outline" onClick={rerun}>
              Rerun
            </Button>
          </div>
        )}
      </div>
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

      <Dialog open={agentLargeEditConfirmOpen} onOpenChange={(open) => { if (!open) { setAgentLargeEditConfirmOpen(false); setPendingLargeEditEdits([]); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Large edit blocked</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            One or more files have a change of more than 40% of lines. This guardrail helps prevent accidental large replacements. Apply these edits anyway?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAgentLargeEditConfirmOpen(false); setPendingLargeEditEdits([]); setAgentReviewApplying(false); }}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!workspaceId || pendingLargeEditEdits.length === 0) return;
                setAgentReviewApplying(true);
                try {
                  const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ edits: pendingLargeEditEdits, confirmLargeEdit: true }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error(data.error || "Failed to apply");
                  for (const e of pendingLargeEditEdits) updateContent(e.path, e.content);
                  setExecuteResult((prev) => {
                    if (!prev) return prev;
                    const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...pendingLargeEditEdits.map((x) => x.path)] };
                    delete (next as any).pendingReview;
                    return next;
                  });
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Failed to apply");
                } finally {
                  setAgentReviewApplying(false);
                  setAgentLargeEditConfirmOpen(false);
                  setPendingLargeEditEdits([]);
                }
              }}
            >
              Apply anyway
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

      {/* Phase F: review each file in diff before apply (like Composer) */}
      {agentReviewQueue.length > 0 && agentReviewQueue[agentReviewIndex] && workspaceId && (
        <InlineEditDiffDialog
          key={`${agentReviewQueue[agentReviewIndex].path}-${agentReviewIndex}`}
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setAgentReviewQueue([]);
              setAgentReviewIndex(0);
            }
          }}
          path={agentReviewQueue[agentReviewIndex].path}
          originalContent={agentReviewQueue[agentReviewIndex].originalContent}
          newContent={agentReviewQueue[agentReviewIndex].newContent}
          workspaceId={workspaceId}
          applyOnAccept={false}
          onAccept={async () => {
            const current = agentReviewQueue[agentReviewIndex];
            const acceptedPaths = new Set(agentReviewAccepted);
            acceptedPaths.add(current.path);
            setAgentReviewAccepted(acceptedPaths);
            const nextIndex = agentReviewIndex + 1;
            if (nextIndex >= agentReviewQueue.length) {
              setAgentReviewQueue([]);
              setAgentReviewIndex(0);
              setAgentReviewApplying(true);
              try {
                const fileEdits = (executeResult as any)?.pendingReview?.fileEdits as { path: string; newContent: string }[] | undefined;
                if (fileEdits?.length) {
                  const edits = fileEdits.filter((e) => acceptedPaths.has(e.path)).map((e) => ({ path: e.path, content: e.newContent }));
                  if (edits.length > 0) {
                    const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ edits }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                      if (res.status === 400 && Array.isArray(data.largeEditPaths) && data.largeEditPaths.length > 0) {
                        setPendingLargeEditEdits(edits);
                        setAgentLargeEditConfirmOpen(true);
                        return;
                      }
                      throw new Error(data.error || "Failed to apply edits");
                    }
                    for (const e of edits) updateContent(e.path, e.content);
                    setExecuteResult((prev) => {
                      if (!prev) return prev;
                      const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...edits.map((x) => x.path)] };
                      delete (next as any).pendingReview;
                      return next;
                    });
                  }
                }
              } catch (e) {
                setError(e instanceof Error ? e.message : "Failed to apply edits");
              } finally {
                setAgentReviewApplying(false);
              }
            } else {
              setAgentReviewIndex(nextIndex);
            }
          }}
          onReject={() => {
            const nextIndex = agentReviewIndex + 1;
            if (nextIndex >= agentReviewQueue.length) {
              setAgentReviewQueue([]);
              setAgentReviewIndex(0);
              if (agentReviewAccepted.size > 0) {
                const fileEdits = (executeResult as any)?.pendingReview?.fileEdits as { path: string; newContent: string }[] | undefined;
                if (fileEdits?.length) {
                  const edits = fileEdits.filter((e) => agentReviewAccepted.has(e.path)).map((e) => ({ path: e.path, content: e.newContent }));
                  if (edits.length > 0) {
                    setAgentReviewApplying(true);
                    (async () => {
                      try {
                        const res = await fetch(`/api/workspaces/${workspaceId}/agent/apply-edits`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ edits }),
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) {
                          if (res.status === 400 && Array.isArray(data.largeEditPaths) && data.largeEditPaths.length > 0) {
                            setPendingLargeEditEdits(edits);
                            setAgentLargeEditConfirmOpen(true);
                            return;
                          }
                          throw new Error(data.error || "Failed to apply");
                        }
                        for (const e of edits) updateContent(e.path, e.content);
                        setExecuteResult((prev) => {
                          if (!prev) return prev;
                          const next = { ...prev, filesEdited: [...(prev.filesEdited ?? []), ...edits.map((x) => x.path)] };
                          delete (next as any).pendingReview;
                          return next;
                        });
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Failed to apply");
                      } finally {
                        setAgentReviewApplying(false);
                      }
                    })();
                  }
                }
              }
            } else {
              setAgentReviewIndex(nextIndex);
            }
          }}
        />
      )}

      <ModelsManagerDialog
        open={modelsManagerOpen}
        onOpenChange={setModelsManagerOpen}
        modelsAvailable={modelsAvailable}
        onUpdated={() => {
          fetch("/api/models/available")
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { if (data) setModelsAvailable(data); })
            .catch(() => {});
        }}
      />
    </div>
  );
}
