"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

const RULES_PATH = ".code-compass-rules";

type RulesEditorDialogProps = {
  workspaceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function RulesEditorDialog({
  workspaceId,
  open,
  onOpenChange,
}: RulesEditorDialogProps) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId || !open) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(RULES_PATH)}`
      );
      if (res.ok) {
        const data = await res.json();
        setContent(data.content ?? "");
        setExists(true);
      } else {
        setContent("");
        setExists(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setContent("");
      setExists(false);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, open]);

  useEffect(() => {
    if (open && workspaceId) load();
  }, [open, workspaceId, load]);

  async function handleSave() {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      if (exists) {
        const res = await fetch(`/api/workspaces/${workspaceId}/files`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: RULES_PATH, content }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to save");
        }
      } else {
        const res = await fetch(`/api/workspaces/${workspaceId}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: RULES_PATH, content }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to create");
        }
        setExists(true);
      }
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] flex flex-col max-w-2xl">
        <DialogHeader>
          <DialogTitle>Project rules (.code-compass-rules)</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          One rule per line. Lines starting with # are comments. These rules are included in Agent and Composer context.
        </p>
        {loading ? (
          <div className="flex-1 min-h-[200px] flex items-center justify-center text-muted-foreground text-sm">
            Loading…
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <Label htmlFor="rules-content" className="sr-only">
              Rules content
            </Label>
            <textarea
              id="rules-content"
              className="flex-1 min-h-[240px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Add project rules here\n# Example: Use TypeScript strict mode"
              spellCheck={false}
            />
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading || saving}
            title={loading ? "Loading…" : saving ? "Saving…" : undefined}
          >
            {saving ? "Saving…" : exists ? "Save" : "Create rules file"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
