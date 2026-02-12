"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, X, Copy, Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminal } from "@/lib/terminal-context";
import { runCommand } from "@/lib/agent/run-command";

type TerminalPanelProps = {
  workspaceId: string | null;
  visible: boolean;
  onToggle: () => void;
};

export function TerminalPanel({
  workspaceId,
  visible,
  onToggle,
}: TerminalPanelProps) {
  const {
    terminals,
    activeTerminal,
    activeTerminalId,
    addTerminal,
    removeTerminal,
    setActiveTerminal,
    addLog,
    clearLogs,
    setTerminalExecuting,
    addTerminalHistory,
  } = useTerminal();
  const logs = activeTerminal?.logs ?? [];
  const history = activeTerminal?.history ?? [];
  const isExecuting = activeTerminal?.isExecuting ?? false;
  const [input, setInput] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
    }
  }, [visible]);

  useEffect(() => {
    setInput("");
    setHistoryIndex(-1);
  }, [activeTerminalId]);

  const executeCommand = useCallback(
    async (command: string) => {
      if (!command.trim() || !workspaceId || !activeTerminalId) return;

      // Cancel any previous command
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      addLog(
        { type: "command", content: `$ ${command}`, command },
        activeTerminalId
      );
      addTerminalHistory(activeTerminalId, command);
      setHistoryIndex(-1);

      setTerminalExecuting(activeTerminalId, true);
      
      // Create new AbortController for this command
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const result = await runCommand(workspaceId, command, abortController.signal);

        if (result.stdout) {
          addLog(
            { type: "output", content: result.stdout, command },
            activeTerminalId
          );
        }
        if (result.stderr) {
          addLog(
            { type: "error", content: result.stderr, command },
            activeTerminalId
          );
        }
        if (result.errorMessage) {
          addLog(
            {
              type: "error",
              content: `Error: ${result.errorMessage}`,
              command,
            },
            activeTerminalId
          );
        }
        if (result.exitCode !== null) {
          const statusText = result.exitCode === 0 ? "succeeded" : "failed";
          addLog(
            {
              type: result.exitCode === 0 ? "info" : "error",
              content: `Command ${statusText} with exit code ${result.exitCode} (${result.durationMs}ms)`,
              command,
            },
            activeTerminalId
          );
        } else if (result.errorMessage) {
          addLog(
            {
              type: "error",
              content: `Command did not complete: ${result.errorMessage}`,
              command,
            },
            activeTerminalId
          );
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          addLog(
            {
              type: "info",
              content: "Command cancelled (Ctrl+C)",
              command,
            },
            activeTerminalId
          );
        } else {
          addLog(
            {
              type: "error",
              content: `Failed to execute: ${error instanceof Error ? error.message : "Unknown error"}`,
              command,
            },
            activeTerminalId
          );
        }
      } finally {
        setTerminalExecuting(activeTerminalId, false);
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    },
    [
      workspaceId,
      activeTerminalId,
      addLog,
      addTerminalHistory,
      setTerminalExecuting,
    ]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const cmd = input.trim();
      if (!cmd || isExecuting) return;
      setInput("");
      executeCommand(cmd);
    },
    [input, isExecuting, executeCommand]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Handle Ctrl+C to cancel running command
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        if (isExecuting && abortControllerRef.current) {
          e.preventDefault();
          abortControllerRef.current.abort();
          addLog(
            {
              type: "info",
              content: "^C",
              command: "",
            },
            activeTerminalId ?? undefined
          );
          if (activeTerminalId) setTerminalExecuting(activeTerminalId, false);
          return;
        }
      }
      
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (history.length > 0) {
          const newIndex =
            historyIndex === -1
              ? history.length - 1
              : Math.max(0, historyIndex - 1);
          setHistoryIndex(newIndex);
          setInput(history[newIndex] ?? "");
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex >= 0) {
          const newIndex = historyIndex + 1;
          if (newIndex >= history.length) {
            setHistoryIndex(-1);
            setInput("");
          } else {
            setHistoryIndex(newIndex);
            setInput(history[newIndex] ?? "");
          }
        }
      }
    },
    [history, historyIndex, isExecuting, activeTerminalId, addLog, setTerminalExecuting]
  );

  const logsContainerRef = useRef<HTMLDivElement>(null);

  const copyTerminalOutput = useCallback(() => {
    const sel = window.getSelection();
    const hasSelection = sel && sel.rangeCount > 0 && !sel.isCollapsed;
    const selectionInPanel =
      hasSelection &&
      logsContainerRef.current &&
      sel.anchorNode &&
      logsContainerRef.current.contains(sel.anchorNode);

    const CLIPBOARD_TERMINAL_TYPE = "application/x-aiforge-terminal";

    if (selectionInPanel && sel && sel.toString()) {
      const text = sel.toString();
      const blob = new Blob([text], { type: "text/plain" });
      const terminalBlob = new Blob(["1"], { type: CLIPBOARD_TERMINAL_TYPE });
      navigator.clipboard.write([new ClipboardItem({ "text/plain": blob, [CLIPBOARD_TERMINAL_TYPE]: terminalBlob })]).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        },
        () => {
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }
      );
      return;
    }

    if (logs.length === 0) return;

    // Format logs similar to Cursor's terminal output format - clean and shareable
    const formatted = logs.map((log) => {
      const time = log.timestamp.toLocaleTimeString();
      
      // For commands, show clean format
      if (log.type === "command" && log.command) {
        return `[${time}] $ ${log.command}`;
      }
      
      // For output/error/info, format cleanly
      const content = log.content.trim();
      
      // Truncate very long outputs (keep first 150 chars + indicator)
      const maxLength = 150;
      const shouldTruncate = content.length > maxLength && log.type !== "error";
      const displayContent = shouldTruncate 
        ? content.slice(0, maxLength) + `... (${content.length - maxLength} more characters)`
        : content;
      
      // Format multi-line content nicely
      const lines = displayContent.split("\n");
      if (lines.length === 1) {
        const prefix = log.type === "error" ? "✗" : log.type === "info" ? "ℹ" : "";
        return `[${time}] ${prefix} ${lines[0]}`;
      }
      
      // For multi-line, show timestamp on first line, indent subsequent lines
      const prefix = log.type === "error" ? "✗" : log.type === "info" ? "ℹ" : "";
      return `[${time}] ${prefix} ${lines[0]}\n${lines.slice(1).map(l => `        ${l}`).join("\n")}`;
    }).join("\n\n");

    const terminalBlob = new Blob(["1"], { type: "application/x-aiforge-terminal" });
    const blob = new Blob([formatted], { type: "text/plain" });
    navigator.clipboard.write([new ClipboardItem({ "text/plain": blob, "application/x-aiforge-terminal": terminalBlob })]).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {
        navigator.clipboard.writeText(formatted).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }
    );
  }, [logs]);

  if (!visible) return null;

  return (
    <div className="flex flex-col h-full border-t border-border bg-[#1e1e1e] text-[#d4d4d4] font-mono text-sm">
      <div className="flex items-center border-b border-border/50 bg-[#252526] shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <TerminalIcon className="h-4 w-4 text-muted-foreground shrink-0 ml-2" />
          {terminals.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              tabIndex={0}
              onClick={() => setActiveTerminal(tab.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveTerminal(tab.id);
                }
              }}
              className={`flex items-center gap-1 px-2 py-1.5 text-xs border-r border-border/50 shrink-0 cursor-pointer ${
                activeTerminalId === tab.id
                  ? "bg-[#1e1e1e] text-foreground font-medium"
                  : "text-muted-foreground hover:bg-[#2d2d2d] hover:text-foreground"
              }`}
            >
              <span className="truncate max-w-[80px]">{tab.name}</span>
              {terminals.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTerminal(tab.id);
                  }}
                  className="rounded p-0.5 hover:bg-[#3d3d3d] text-muted-foreground hover:text-foreground"
                  title="Close terminal"
                  aria-label="Close terminal"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={addTerminal}
            title="New terminal"
            aria-label="New terminal"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 shrink-0">
          {logs.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={copyTerminalOutput}
              title="Copy selection (or all). Select text in the output area and press Ctrl+C to copy."
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 mr-1" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" />
                  Copy
                </>
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => clearLogs()}
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggle}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div
        ref={logsContainerRef}
        role="log"
        tabIndex={0}
        className="flex-1 overflow-y-auto p-2 space-y-0.5 min-h-0 select-text outline-none"
        aria-label="Terminal output"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "c") {
            e.preventDefault();
            copyTerminalOutput();
          }
        }}
      >
        {logs.length === 0 && !input && (
          <div className="text-muted-foreground text-xs px-2 py-2">
            Terminal ready. Type a command and press Enter.
          </div>
        )}
        {logs.map((log) => {
          const time = log.timestamp.toLocaleTimeString();
          const isCommand = log.type === "command";
          const isError = log.type === "error";
          const isInfo = log.type === "info";

          if (isCommand && log.command) {
            return (
              <div
                key={log.id}
                className="px-2 py-0.5 text-[#4ec9b0]"
              >
                <span className="text-[#858585] text-xs">[{time}]</span>{" "}
                <span className="font-medium">$ {log.command}</span>
              </div>
            );
          }

          return (
            <div
              key={log.id}
              className={`px-2 py-0.5 ${
                isError
                  ? "text-[#f48771]"
                  : isInfo
                    ? "text-[#569cd6]"
                    : "text-[#d4d4d4]"
              }`}
            >
              <span className="text-[#858585] text-xs">[{time}]</span>{" "}
              <span className="whitespace-pre-wrap break-words">{log.content}</span>
            </div>
          );
        })}
        {/* Inline prompt line (Cursor-style: prompt + input in same buffer) */}
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-0 px-2 py-0.5 text-[#4ec9b0] min-h-[1.5rem]"
        >
          <span className="font-medium shrink-0">$ </span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isExecuting ? "Command running... (Ctrl+C to cancel)" : ""}
            disabled={!workspaceId || isExecuting}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[#d4d4d4] font-mono text-sm px-1 placeholder:text-[#858585] disabled:opacity-70"
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
