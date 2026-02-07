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

type AIPanelTab = "chat" | "composer" | "agent";

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isSettings = pathname === "/app/settings" || pathname.startsWith("/app/settings/");
  const workspaceId =
    !isSettings && pathname.startsWith("/app/")
      ? pathname.replace("/app/", "").split("/")[0]
      : null;
  const [aiPanelTab, setAiPanelTab] = useState<AIPanelTab>("chat");

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

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Left sidebar */}
      <aside className="flex w-56 flex-col border-r border-border bg-muted/30">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3">
          <span className="font-semibold text-foreground">AIForge</span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <WorkspaceSelector />
          <div className="mt-4">
            <FileTree workspaceId={workspaceId} />
          </div>
        </div>
        <div className="border-t border-border p-2 space-y-1">
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

      {/* Center: editor area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {workspaceId ? <EditorArea /> : children}
      </main>

      {/* Right: AI panel */}
      <aside className="flex w-80 flex-col border-l border-border bg-muted/20">
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
        <ChatPanel workspaceId={workspaceId} activeTab={aiPanelTab} />
      </aside>
      <CommandPalette />
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
