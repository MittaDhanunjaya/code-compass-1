"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Settings, Layers } from "lucide-react";
import { WorkspaceStackSettings } from "@/components/workspace-stack-settings";
import { Button } from "@/components/ui/button";

type TabId = "stack";

export default function WorkspaceSettingsPage() {
  const params = useParams();
  const router = useRouter();
  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : null;

  if (!workspaceId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-muted-foreground">
        <p>No workspace selected.</p>
        <Link href="/app" className="mt-2 text-primary hover:underline">
          Back to app
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/app/${workspaceId}`)}
          className="gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <span className="text-muted-foreground">/</span>
        <Settings className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">Workspace settings</span>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-48 flex-col border-r border-border bg-muted/20 p-2">
          <nav className="space-y-0.5">
            <TabLink
              id="stack"
              label="Stack & Commands"
              icon={<Layers className="h-4 w-4" />}
              active
            />
          </nav>
        </aside>
        <div className="flex-1 overflow-y-auto">
          <section className="border-b border-border px-4 py-2">
            <h2 className="text-sm font-semibold">Stack & Commands</h2>
            <p className="text-xs text-muted-foreground">
              Configure lint, test, and run commands via .code-compass/config.json (used by sandbox and CI).
            </p>
          </section>
          <WorkspaceStackSettings workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}

function TabLink({
  id,
  label,
  icon,
  active,
}: {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
      }`}
    >
      {icon}
      {label}
    </div>
  );
}
