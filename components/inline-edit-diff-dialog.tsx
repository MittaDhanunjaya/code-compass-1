"use client";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

function getLanguage(path: string): string {
  const ext = path.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", py: "python", css: "css", html: "html",
  };
  return map[ext] ?? "plaintext";
}

export type InlineEditDiffDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  originalContent: string;
  newContent: string;
  workspaceId: string;
  onAccept: () => void | Promise<void>;
  onReject?: () => void;
  /** When false, dialog does not PATCH the file; parent applies later (e.g. Agent batch apply). Default true. */
  applyOnAccept?: boolean;
};

export function InlineEditDiffDialog({
  open,
  onOpenChange,
  path,
  originalContent,
  newContent,
  workspaceId,
  onAccept,
  onReject,
  applyOnAccept = true,
}: InlineEditDiffDialogProps) {
  const handleAccept = async () => {
    try {
      if (applyOnAccept) {
        const res = await fetch(`/api/workspaces/${workspaceId}/files`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, content: newContent }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to save file");
        }
      }
      await onAccept();
      onOpenChange(false);
    } catch (e) {
      console.error("Accept inline edit failed:", e);
      throw e;
    }
  };

  const handleReject = () => {
    onReject?.();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl flex flex-col gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle>Review edit: {path}</DialogTitle>
        </DialogHeader>
        <div className="min-h-[400px] h-[60vh] shrink-0 overflow-hidden rounded border border-border bg-[#1e1e1e]">
          <MonacoDiffEditor
            height="100%"
            language={getLanguage(path)}
            original={originalContent ?? ""}
            modified={newContent ?? ""}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: true },
              lineNumbers: "on",
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleReject}>
            Reject
          </Button>
          <Button onClick={handleAccept}>
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
