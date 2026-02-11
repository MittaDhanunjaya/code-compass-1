"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import { EditorProvider } from "@/lib/editor-context";
import { TerminalProvider } from "@/lib/terminal-context";
import { ChatPanel } from "@/components/chat-panel";
import { CommandPalette } from "@/components/command-palette";
import { EditorArea } from "@/components/editor-area";
import { FileTree } from "@/components/file-tree";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceSelector } from "@/components/workspace-selector";
import { CmdKOverlay } from "@/components/cmd-k-overlay";
import { FirstRunChecklist } from "@/components/first-run-checklist";
import { RulesEditorDialog } from "@/components/rules-editor-dialog";

type AIPanelTab = "chat" | "composer" | "agent";

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isSettings = pathname === "/app/settings" || pathname.startsWith("/app/settings/");
  const isWorkspaceSettings = /^\/app\/[^/]+\/settings\/?$/.test(pathname);
  const workspaceId =
    !isSettings && pathname.startsWith("/app/")
      ? pathname.replace("/app/", "").split("/")[0]
      : null;
  const [aiPanelTab, setAiPanelTab] = useState<AIPanelTab>("chat");
  const [rulesDialogOpen, setRulesDialogOpen] = useState(false);

  useEffect(() => {
    if (pathname !== "/app" || isSettings) return;
    let cancelled = false;
    fetch("/api/workspaces/active")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.activeWorkspaceId) return;
        router.replace(`/app/${data.activeWorkspaceId}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, isSettings, router]);

  useEffect(() => {
    const openRules = () => setRulesDialogOpen(true);
    window.addEventListener("open-rules-editor", openRules);
    return () => window.removeEventListener("open-rules-editor", openRules);
  }, []);

  useEffect(() => {
    const onCommand = (ev: Event) => {
      const { commandId } = (ev as CustomEvent<{ commandId: string }>).detail ?? {};
      if (commandId === "runAgentOnCurrentFile") setAiPanelTab("agent");
      else if (commandId === "debugFromLog") setAiPanelTab("chat");
      else if (commandId === "reviewAllChanges") setAiPanelTab("agent");
    };
    const onRunDebugFromLog = () => setAiPanelTab("chat");
    window.addEventListener("command-palette-run", onCommand);
    window.addEventListener("aiforge-run-debug-from-log", onRunDebugFromLog);
    return () => {
      window.removeEventListener("command-palette-run", onCommand);
      window.removeEventListener("aiforge-run-debug-from-log", onRunDebugFromLog);
    };
  }, []);

  // First-run wizard: when navigating with a pending playbook, switch to Agent tab
  useEffect(() => {
    if (!workspaceId) return;
    try {
      const pending = sessionStorage.getItem("pendingPlaybookId");
      if (pending) setAiPanelTab("agent");
    } catch {}
  }, [workspaceId]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Left sidebar - min-h-0 so flex-1 scrollable area gets bounded height */}
      <aside className="flex w-56 flex-col min-h-0 border-r border-border bg-muted/30">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="font-semibold text-foreground">AIForge</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2">
          <WorkspaceSelector />
          {workspaceId && (
            <>
              <button
                type="button"
                onClick={() => setRulesDialogOpen(true)}
                className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Edit project rules (.aiforge-rules) used by Agent and Composer"
              >
                Project rules
              </button>
              <Link
                href={`/app/${workspaceId}/settings`}
                className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="Stack & commands (.code-compass/config.json)"
              >
                Stack & Commands
              </Link>
            </>
          )}
          <div className="mt-4">
            <FileTree workspaceId={workspaceId} />
          </div>
        </div>
        <div className="border-t border-border p-2 space-y-1">
          <Link
            href="/app/get-started"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            Get started
          </Link>
          <Link
            href="/app/settings"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
          <UserMenu />
        </div>
      </aside>

      {/* Center: editor area or workspace settings */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {workspaceId && !isWorkspaceSettings ? <EditorArea /> : children}
      </main>

      {/* Right: AI panel - min-h-0 + overflow-y-auto so content scrolls when long */}
      <aside className="flex w-80 flex-col min-h-0 border-l border-border bg-muted/20 overflow-hidden">
        <div className="flex h-12 shrink-0 items-center border-b border-border">
          <div className="flex gap-1 px-2">
            {(["chat", "composer", "agent"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setAiPanelTab(tab)}
                className={`rounded px-3 py-2 text-sm font-medium capitalize ${
                  aiPanelTab === tab
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          <ChatPanel workspaceId={workspaceId} activeTab={aiPanelTab} />
        </div>
      </aside>
      <CommandPalette />
      <FirstRunChecklist />
      <RulesEditorDialog
        workspaceId={workspaceId}
        open={rulesDialogOpen}
        onOpenChange={setRulesDialogOpen}
      />
      {workspaceId && (
        <CmdKOverlay
          workspaceId={workspaceId}
          onAction={(action, selection, filePath) => {
            // Switch to chat tab and send action as message
            setAiPanelTab("chat");
            // Trigger action via custom event that ChatPanel will listen to
            window.dispatchEvent(
              new CustomEvent("cmd-k-action", {
                detail: { action, selection, filePath },
              })
            );
          }}
        />
      )}
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSettings = pathname === "/app/settings" || pathname.startsWith("/app/settings/");
  const workspaceId =
    !isSettings && pathname.startsWith("/app/")
      ? pathname.replace("/app/", "").split("/")[0]
      : null;

  return (
    <EditorProvider workspaceId={workspaceId}>
      <TerminalProvider workspaceId={workspaceId}>
        <AppShellInner>{children}</AppShellInner>
      </TerminalProvider>
    </EditorProvider>
  );
}
