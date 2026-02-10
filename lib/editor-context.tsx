"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
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
  /** Apply edits from an external source (e.g. rename symbol); updates tabs and marks not dirty. */
  applyExternalEdits: (edits: { path: string; content: string }[]) => void;
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
  const restoredForWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    setWsId(workspaceId);
    setTabs([]);
    setActiveTabState(null);
    if (!workspaceId) setSelectionState(null);
    restoredForWorkspaceRef.current = null;
  }, [workspaceId]);

  const SESSION_KEY = (id: string) => `editor-session-${id}`;

  // Persist open tabs and active tab per workspace
  useEffect(() => {
    if (!wsId || tabs.length === 0) return;
    try {
      localStorage.setItem(
        SESSION_KEY(wsId),
        JSON.stringify({
          paths: tabs.map((t) => t.path),
          activePath: activeTab,
        })
      );
    } catch (_) {}
  }, [wsId, tabs, activeTab]);

  // Restore session when workspace loads and we have no tabs (reload or switch); only once per workspace
  useEffect(() => {
    if (!wsId || tabs.length > 0 || restoredForWorkspaceRef.current === wsId) return;
    const raw = localStorage.getItem(SESSION_KEY(wsId));
    if (!raw) return;
    let session: { paths: string[]; activePath: string | null };
    try {
      session = JSON.parse(raw);
    } catch {
      return;
    }
    if (!session.paths?.length) return;
    restoredForWorkspaceRef.current = wsId;
    let cancelled = false;
    (async () => {
      const contents = await Promise.all(
        session.paths.map((path: string) =>
          fetch(
            `/api/workspaces/${wsId}/files?path=${encodeURIComponent(path)}`
          ).then((r) => (r.ok ? r.json() : { content: "" }))
        )
      );
      if (cancelled) return;
      const newTabs: Tab[] = session.paths.map((path, i) => ({
        path,
        content: contents[i]?.content ?? "",
        dirty: false,
        savedContent: contents[i]?.content ?? "",
      }));
      setTabs(newTabs);
      setActiveTabState(
        session.activePath && session.paths.includes(session.activePath)
          ? session.activePath
          : session.paths[0]
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId, tabs.length]);

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

  const applyExternalEdits = useCallback((edits: { path: string; content: string }[]) => {
    if (edits.length === 0) return;
    setTabs((prev) => {
      const byPath = new Map(edits.map((e) => [e.path, e.content]));
      return prev.map((t) => {
        const content = byPath.get(t.path);
        if (content === undefined) return t;
        return { ...t, content, savedContent: content, dirty: false };
      });
    });
  }, []);

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
    applyExternalEdits,
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
