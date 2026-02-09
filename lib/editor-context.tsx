"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Tab = {
  path: string;
  content: string;
  dirty: boolean;
  savedContent: string;
};

export type EditorSelection = { path: string; text: string } | null;

/** Monaco-style range (1-based). Used for Cmd+K inline apply (Tab to apply). */
export type EditorRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

export type PendingCmdKSuggestion = { path: string; newContent: string; range: EditorRange } | null;

type EditorContextValue = {
  tabs: Tab[];
  activeTab: string | null;
  selection: EditorSelection;
  pendingCmdKSuggestion: PendingCmdKSuggestion;
  setPendingCmdKSuggestion: (s: PendingCmdKSuggestion) => void;
  openFile: (path: string, content: string) => void;
  closeTab: (path: string) => void;
  setActiveTab: (path: string | null) => void;
  setSelection: (path: string, text: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  getTab: (path: string) => Tab | undefined;
  workspaceId: string | null;
  setWorkspaceId: (id: string | null) => void;
};

const EditorContext = createContext<EditorContextValue | undefined>(undefined);

export function EditorProvider({
  children,
  workspaceId,
}: {
  children: ReactNode;
  workspaceId: string | null;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTabState] = useState<string | null>(null);
  const [selection, setSelectionState] = useState<EditorSelection>(null);
  const [pendingCmdKSuggestion, setPendingCmdKSuggestion] = useState<PendingCmdKSuggestion>(null);
  const [wsId, setWsId] = useState<string | null>(workspaceId);

  useEffect(() => {
    setWsId(workspaceId);
    if (!workspaceId) {
      setTabs([]);
      setActiveTabState(null);
      setSelectionState(null);
    }
  }, [workspaceId]);

  const openFile = useCallback((path: string, content: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === path);
      if (existing) return prev;
      return [
        ...prev,
        {
          path,
          content,
          dirty: false,
          savedContent: content,
        },
      ];
    });
    setActiveTabState(path);
  }, []);

  const closeTab = useCallback((path: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path);
      const next = prev.filter((t) => t.path !== path);
      if (activeTab === path && next.length > 0) {
        const newActive = idx > 0 ? prev[idx - 1].path : next[0].path;
        setActiveTabState(newActive);
      } else if (activeTab === path) {
        setActiveTabState(null);
      }
      return next;
    });
  }, [activeTab]);

  const setActiveTab = useCallback((path: string | null) => {
    setActiveTabState(path);
  }, []);

  const setSelection = useCallback((path: string, text: string) => {
    setSelectionState(text ? { path, text } : null);
  }, []);

  const updateContent = useCallback((path: string, content: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.path === path
          ? { ...t, content, dirty: content !== t.savedContent }
          : t
      )
    );
  }, []);

  const saveFile = useCallback(
    async (path: string) => {
      const tab = tabs.find((t) => t.path === path);
      if (!tab || !tab.dirty || !wsId) return;

      const res = await fetch(`/api/workspaces/${wsId}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: tab.content }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.path === path
            ? { ...t, dirty: false, savedContent: t.content }
            : t
        )
      );
    },
    [tabs, wsId]
  );

  const getTab = useCallback(
    (path: string) => tabs.find((t) => t.path === path),
    [tabs]
  );

  const value: EditorContextValue = {
    tabs,
    activeTab,
    selection,
    pendingCmdKSuggestion,
    setPendingCmdKSuggestion,
    openFile,
    closeTab,
    setActiveTab,
    setSelection,
    updateContent,
    saveFile,
    getTab,
    workspaceId: wsId,
    setWorkspaceId: setWsId,
  };

  return (
    <EditorContext.Provider value={value}>{children}</EditorContext.Provider>
  );
}

export function useEditor() {
  const context = useContext(EditorContext);
  if (context === undefined) {
    throw new Error("useEditor must be used within an EditorProvider");
  }
  return context;
}
