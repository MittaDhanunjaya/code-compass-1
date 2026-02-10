"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, X, Github, Key, FolderOpen, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PLAYBOOKS, getPlaybook } from "@/lib/playbooks";

const STORAGE_KEY_DISMISSED = "firstRunChecklistDismissed";
const STORAGE_KEY_STEP1 = "firstRunStep1Done"; // API key added
const STORAGE_KEY_STEP2 = "firstRunStep2Done"; // workspace created
const STORAGE_KEY_STEP3 = "firstRunStep3Done"; // GitHub connected
const STORAGE_KEY_STEP4 = "firstRunStep4Done"; // sample "fix failing test" tried
const STORAGE_KEY_STEP5 = "firstRunStep5Done"; // playbook tried

function getStored(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function setStored(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "true");
    else localStorage.removeItem(key);
  } catch {}
}

type FirstRunChecklistProps = {
  workspaceCount?: number;
  hasApiKeyHint?: boolean;
  githubLinked?: boolean;
};

export function FirstRunChecklist({
  workspaceCount: workspaceCountProp,
  hasApiKeyHint = false,
  githubLinked: githubLinkedProp = false,
}: FirstRunChecklistProps = {}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [workspaceCount, setWorkspaceCount] = useState(workspaceCountProp ?? 0);
  const [githubLinked, setGitHubLinked] = useState(githubLinkedProp);

  useEffect(() => {
    const alreadyDismissed = getStored(STORAGE_KEY_DISMISSED);
    if (alreadyDismissed) {
      setDismissed(true);
      return;
    }
    setDismissed(false);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (workspaceCountProp != null) {
      setWorkspaceCount(workspaceCountProp);
      return;
    }
    let cancelled = false;
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || Array.isArray(data) === false) return;
        setWorkspaceCount(data.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceCountProp]);

  useEffect(() => {
    if (githubLinkedProp) {
      setGitHubLinked(true);
      return;
    }
    let cancelled = false;
    fetch("/api/user/github")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setGitHubLinked(data?.linked === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [githubLinkedProp]);

  const step1Done = hasApiKeyHint || getStored(STORAGE_KEY_STEP1);
  const step2Done = workspaceCount > 0 || getStored(STORAGE_KEY_STEP2);
  const step3Done = githubLinked || getStored(STORAGE_KEY_STEP3);
  const step4Done = getStored(STORAGE_KEY_STEP4);
  const step5Done = getStored(STORAGE_KEY_STEP5);

  useEffect(() => {
    if (hasApiKeyHint && !getStored(STORAGE_KEY_STEP1)) setStored(STORAGE_KEY_STEP1, true);
  }, [hasApiKeyHint]);
  useEffect(() => {
    if (workspaceCount > 0 && !getStored(STORAGE_KEY_STEP2)) setStored(STORAGE_KEY_STEP2, true);
  }, [workspaceCount]);
  useEffect(() => {
    if (githubLinked && !getStored(STORAGE_KEY_STEP3)) setStored(STORAGE_KEY_STEP3, true);
  }, [githubLinked]);

  const handleClose = () => {
    setOpen(false);
    if (dontShowAgain) {
      setStored(STORAGE_KEY_DISMISSED, true);
      setDismissed(true);
    }
  };

  const runSampleTask = useCallback(() => {
    setStored(STORAGE_KEY_STEP4, true);
    setOpen(false);
    try {
      sessionStorage.setItem("pendingPlaybookId", "fix-failing-test");
    } catch {}
    router.push("/app");
  }, [router]);

  const runPlaybook = useCallback(
    (playbookId: string) => {
      setStored(STORAGE_KEY_STEP5, true);
      setOpen(false);
      try {
        sessionStorage.setItem("pendingPlaybookId", playbookId);
      } catch {}
      router.push("/app");
    },
    [router]
  );

  if (dismissed) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md gap-4 max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle>Get started with Code Compass</DialogTitle>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Complete these steps to get the most out of the app. You can skip or do them in any order.
        </p>
        <ol className="space-y-3 text-sm">
          <li className="flex items-center gap-3">
            {step3Done ? (
              <Check className="h-5 w-5 shrink-0 text-green-600" />
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                1
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium flex items-center gap-2">
                <Github className="h-4 w-4" /> Connect GitHub
              </span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Import repos and sync branches. Optional but recommended for real projects.
              </p>
              {!step3Done && (
                <Link href="/app/settings?tab=github">
                  <Button variant="outline" size="sm" className="mt-2 gap-1">
                    Connect GitHub <ChevronRight className="h-3 w-3" />
                  </Button>
                </Link>
              )}
            </div>
          </li>
          <li className="flex items-center gap-3">
            {step1Done ? (
              <Check className="h-5 w-5 shrink-0 text-green-600" />
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                2
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium flex items-center gap-2">
                <Key className="h-4 w-4" /> Add a model API key
              </span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Required for Chat, Composer, Agent, and tab completion.
              </p>
              {!step1Done && (
                <Link href="/app/settings?tab=keys">
                  <Button variant="outline" size="sm" className="mt-2 gap-1">
                    Open Settings <ChevronRight className="h-3 w-3" />
                  </Button>
                </Link>
              )}
            </div>
          </li>
          <li className="flex items-center gap-3">
            {step2Done ? (
              <Check className="h-5 w-5 shrink-0 text-green-600" />
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                3
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium flex items-center gap-2">
                <FolderOpen className="h-4 w-4" /> Open a repo
              </span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Create a workspace (empty, from GitHub URL, or open a local folder).
              </p>
            </div>
          </li>
          <li className="flex items-center gap-3">
            {step4Done ? (
              <Check className="h-5 w-5 shrink-0 text-green-600" />
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                4
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium">Run a sample task</span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Try &quot;Fix this failing test&quot;: open a workspace, go to Agent, paste an error log, and run.
              </p>
              {!step4Done && (
                <Button variant="outline" size="sm" className="mt-2 gap-1" onClick={runSampleTask}>
                  Go and try it <ChevronRight className="h-3 w-3" />
                </Button>
              )}
            </div>
          </li>
          <li className="flex items-center gap-3">
            {step5Done ? (
              <Check className="h-5 w-5 shrink-0 text-green-600" />
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                5
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium flex items-center gap-2">
                <BookOpen className="h-4 w-4" /> Try a playbook
              </span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Pre-made tasks: add endpoint, migrate to App Router, add tests, and more.
              </p>
              {!step5Done && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {PLAYBOOKS.slice(0, 3).map((p) => (
                    <Button
                      key={p.id}
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => runPlaybook(p.id)}
                    >
                      {p.title}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </li>
        </ol>
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="rounded border-border"
          />
          Don’t show again
        </label>
        <Button onClick={handleClose} className="w-full">
          Got it
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export { getPlaybook };
