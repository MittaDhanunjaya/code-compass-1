"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type TerminalLogEntry = {
  id: string;
  timestamp: Date;
  type: "command" | "output" | "error" | "info";
  content: string;
  command?: string; // For command entries, the original command
};

export type TerminalTab = {
  id: string;
  name: string;
  logs: TerminalLogEntry[];
  history: string[];
  isExecuting: boolean;
};

type TerminalContextValue = {
  terminals: TerminalTab[];
  activeTerminalId: string | null;
  activeTerminal: TerminalTab | null;
  addTerminal: () => string;
  removeTerminal: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  addLog: (entry: Omit<TerminalLogEntry, "id" | "timestamp">, terminalId?: string) => void;
  clearLogs: (terminalId?: string) => void;
  setTerminalExecuting: (terminalId: string, value: boolean) => void;
  addTerminalHistory: (terminalId: string, command: string) => void;
  workspaceId: string | null;
};

const TerminalContext = createContext<TerminalContextValue | undefined>(
  undefined
);

function createTerminalTab(name?: string): TerminalTab {
  return {
    id: crypto.randomUUID(),
    name: name ?? `Terminal ${Date.now().toString(36).slice(-4)}`,
    logs: [],
    history: [],
    isExecuting: false,
  };
}

export function TerminalProvider({
  children,
  workspaceId,
}: {
  children: ReactNode;
  workspaceId: string | null;
}) {
  const [terminals, setTerminals] = useState<TerminalTab[]>(() => {
    const first = createTerminalTab("Terminal 1");
    return [first];
  });
  const [activeTerminalId, setActiveTerminalIdState] = useState<string | null>(null);

  // Resolve effective active id (first run: use first terminal)
  const resolvedActiveId =
    activeTerminalId != null && terminals.some((t) => t.id === activeTerminalId)
      ? activeTerminalId
      : terminals[0]?.id ?? null;

  const activeTerminal =
    resolvedActiveId != null
      ? terminals.find((t) => t.id === resolvedActiveId) ?? null
      : terminals[0] ?? null;

  const setActiveTerminal = useCallback((id: string) => {
    setActiveTerminalIdState(id);
  }, []);

  const addTerminal = useCallback((): string => {
    const index = terminals.length + 1;
    const tab = createTerminalTab(`Terminal ${index}`);
    setTerminals((prev) => [...prev, tab]);
    setActiveTerminalIdState(tab.id);
    return tab.id;
  }, [terminals.length]);

  const removeTerminal = useCallback((id: string) => {
    setTerminals((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) return [createTerminalTab("Terminal 1")];
      return next;
    });
    setActiveTerminalIdState((current) => {
      if (current !== id) return current;
      const next = terminals.filter((t) => t.id !== id);
      const idx = terminals.findIndex((t) => t.id === id);
      const nextActive = idx <= 0 ? next[0] : next[Math.min(idx - 1, next.length - 1)];
      return nextActive?.id ?? next[0]?.id ?? null;
    });
  }, [terminals]);

  const addLog = useCallback(
    (entry: Omit<TerminalLogEntry, "id" | "timestamp">, terminalId?: string) => {
      const targetId = terminalId ?? resolvedActiveId ?? terminals[0]?.id;
      if (!targetId) return;
      const logEntry = {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      };
      setTerminals((prev) =>
        prev.map((t) =>
          t.id === targetId
            ? { ...t, logs: [...t.logs, logEntry] }
            : t
        )
      );
    },
    [resolvedActiveId, terminals]
  );

  const clearLogs = useCallback((terminalId?: string) => {
    const targetId = terminalId ?? resolvedActiveId ?? terminals[0]?.id;
    if (!targetId) return;
    setTerminals((prev) =>
      prev.map((t) => (t.id === targetId ? { ...t, logs: [] } : t))
    );
  }, [resolvedActiveId, terminals]);

  const setTerminalExecuting = useCallback((terminalId: string, value: boolean) => {
    setTerminals((prev) =>
      prev.map((t) => (t.id === terminalId ? { ...t, isExecuting: value } : t))
    );
  }, []);

  const addTerminalHistory = useCallback((terminalId: string, command: string) => {
    setTerminals((prev) =>
      prev.map((t) => {
        if (t.id !== terminalId) return t;
        const newHistory = [...t.history, command].slice(-50);
        return { ...t, history: newHistory };
      })
    );
  }, []);

  const value = useMemo<TerminalContextValue>(
    () => ({
      terminals,
      activeTerminalId: activeTerminal?.id ?? null,
      activeTerminal,
      addTerminal,
      removeTerminal,
      setActiveTerminal,
      addLog,
      clearLogs,
      setTerminalExecuting,
      addTerminalHistory,
      workspaceId,
    }),
    [
      terminals,
      activeTerminal,
      addTerminal,
      removeTerminal,
      setActiveTerminal,
      addLog,
      clearLogs,
      setTerminalExecuting,
      addTerminalHistory,
      workspaceId,
    ]
  );

  return (
    <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>
  );
}

export function useTerminal() {
  const context = useContext(TerminalContext);
  if (context === undefined) {
    throw new Error("useTerminal must be used within a TerminalProvider");
  }
  return context;
}
