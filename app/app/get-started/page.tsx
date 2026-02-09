"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Key, FolderOpen, Command } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GetStartedPage() {
  const router = useRouter();

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 max-w-lg mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Get started with Code Compass</h1>
      <p className="text-muted-foreground text-center mb-8">
        Follow these steps to get the most out of the app.
      </p>
      <ol className="w-full space-y-4 text-left">
        <li className="flex items-start gap-3 rounded-lg border border-border p-4">
          <Key className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
          <div>
            <span className="font-medium">Add an API key</span>
            <p className="text-sm text-muted-foreground mt-0.5">
              Required for Chat, Composer, Agent, and tab completion. Add at least one provider in Settings.
            </p>
            <Link href="/app/settings?tab=keys">
              <Button variant="outline" size="sm" className="mt-2 gap-1">
                Open API Keys <ChevronRight className="h-3 w-3" />
              </Button>
            </Link>
          </div>
        </li>
        <li className="flex items-start gap-3 rounded-lg border border-border p-4">
          <FolderOpen className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
          <div>
            <span className="font-medium">Create a workspace</span>
            <p className="text-sm text-muted-foreground mt-0.5">
              Start with an empty workspace, import from GitHub, or open a local folder (Chrome/Edge).
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 gap-1"
              onClick={() => router.push("/app")}
            >
              Go to workspaces <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </li>
        <li className="flex items-start gap-3 rounded-lg border border-border p-4">
          <Command className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
          <div>
            <span className="font-medium">Try Cmd+K (or Ctrl+K)</span>
            <p className="text-sm text-muted-foreground mt-0.5">
              Select code in the editor and use quick actions: Explain, Refactor, Write tests, Add docs. Tab to accept suggestions.
            </p>
          </div>
        </li>
      </ol>
      <div className="mt-8 flex gap-2">
        <Button asChild>
          <Link href="/app/settings">Open Settings</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/app">Back to app</Link>
        </Button>
      </div>
    </div>
  );
}
