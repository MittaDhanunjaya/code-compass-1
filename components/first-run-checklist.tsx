"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Check, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STORAGE_KEY_DISMISSED = "firstRunChecklistDismissed";
const STORAGE_KEY_STEP1 = "firstRunStep1Done"; // API key added
const STORAGE_KEY_STEP2 = "firstRunStep2Done"; // workspace created
const STORAGE_KEY_STEP3 = "firstRunStep3Done"; // Cmd+K tried (optional)

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
};

export function FirstRunChecklist({
  workspaceCount: workspaceCountProp,
  hasApiKeyHint = false,
}: FirstRunChecklistProps = {}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [workspaceCount, setWorkspaceCount] = useState(workspaceCountProp ?? 0);

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
    return () => { cancelled = true; };
  }, [workspaceCountProp]);

  const step1Done = hasApiKeyHint || getStored(STORAGE_KEY_STEP1);
  const step2Done = workspaceCount > 0 || getStored(STORAGE_KEY_STEP2);

  useEffect(() => {
    if (hasApiKeyHint && !getStored(STORAGE_KEY_STEP1)) setStored(STORAGE_KEY_STEP1, true);
  }, [hasApiKeyHint]);
  useEffect(() => {
    if (workspaceCount > 0 && !getStored(STORAGE_KEY_STEP2)) setStored(STORAGE_KEY_STEP2, true);
  }, [workspaceCount]);

  const handleClose = () => {
    setOpen(false);
    if (dontShowAgain) {
      setStored(STORAGE_KEY_DISMISSED, true);
      setDismissed(true);
    }
  };

  if (dismissed) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md gap-4">
        <DialogHeader className="flex flex-row items-center justify-between space-y-0">
          <DialogTitle>Get started with Code Compass</DialogTitle>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>
        <ol className="space-y-3 text-sm">
          <li className="flex items-center gap-3">
            {step1Done ? (
              <Check className="h-5 w-5 shrink-0 text-green-600" />
            ) : (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                1
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium">Add an API key</span>
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
                2
              </span>
            )}
            <div className="flex-1">
              <span className="font-medium">Create a workspace</span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Empty, from GitHub URL, or open a local folder (Chrome/Edge).
              </p>
            </div>
          </li>
          <li className="flex items-center gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              3
            </span>
            <div className="flex-1">
              <span className="font-medium">Try Cmd+K (or Ctrl+K)</span>
              <p className="text-muted-foreground text-xs mt-0.5">
                Select code and use quick actions: Explain, Refactor, Write tests, Add docs.
              </p>
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
