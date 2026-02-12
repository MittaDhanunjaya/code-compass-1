"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { COPY } from "@/lib/copy";

type AgentConfirmDialogsProps = {
  largeFileConfirmOpen: boolean;
  largeFileCount: number;
  onLargeFileClose: () => void;
  onLargeFileConfirm: () => void;
  agentFullFileReplaceConfirmOpen: boolean;
  onFullFileReplaceClose: () => void;
  onFullFileReplaceConfirm: () => void;
  agentLargeEditConfirmOpen: boolean;
  onLargeEditClose: () => void;
  onLargeEditConfirm: () => void;
  aggressiveConfirmOpen: boolean;
  onAggressiveClose: () => void;
  onAggressiveConfirm: () => void;
  protectedConfirmOpen: boolean;
  protectedPathsList: string[];
  onProtectedClose: () => void;
  onProtectedCancel: () => void;
  onProtectedAllow: () => void;
};

export function AgentConfirmDialogs({
  largeFileConfirmOpen,
  largeFileCount,
  onLargeFileClose,
  onLargeFileConfirm,
  agentFullFileReplaceConfirmOpen,
  onFullFileReplaceClose,
  onFullFileReplaceConfirm,
  agentLargeEditConfirmOpen,
  onLargeEditClose,
  onLargeEditConfirm,
  aggressiveConfirmOpen,
  onAggressiveClose,
  onAggressiveConfirm,
  protectedConfirmOpen,
  protectedPathsList,
  onProtectedClose,
  onProtectedCancel,
  onProtectedAllow,
}: AgentConfirmDialogsProps) {
  return (
    <>
      <Dialog open={largeFileConfirmOpen} onOpenChange={(open) => { if (!open) onLargeFileClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm large change</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This action will change {largeFileCount} file(s) in this workspace. In Safe Edit mode we recommend reviewing large changes carefully. Continue?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onLargeFileClose}>
              Cancel
            </Button>
            <Button onClick={onLargeFileConfirm}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={agentFullFileReplaceConfirmOpen} onOpenChange={(open) => { if (!open) onFullFileReplaceClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Full file replace</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This replaces almost the entire file. If you didn&apos;t ask for a full rewrite, cancel and re-run with a clearer request. Apply anyway?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onFullFileReplaceClose}>
              Cancel
            </Button>
            <Button onClick={onFullFileReplaceConfirm}>Apply anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={agentLargeEditConfirmOpen} onOpenChange={(open) => { if (!open) onLargeEditClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Large edit blocked</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            One or more files have a change of more than 40% of lines. This guardrail helps prevent accidental large replacements. Apply these edits anyway?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onLargeEditClose}>
              Cancel
            </Button>
            <Button onClick={onLargeEditConfirm}>Apply anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={aggressiveConfirmOpen} onOpenChange={(open) => { if (!open) onAggressiveClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aggressive scope with Safe Edit on</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            Aggressive mode may change many files/lines. Safe Edit is on; some changes may be blocked. Continue?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={onAggressiveClose}>
              Cancel
            </Button>
            <Button onClick={onAggressiveConfirm}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={protectedConfirmOpen} onOpenChange={(open) => { if (!open) onProtectedClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{COPY.safety.title}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">{COPY.safety.body(protectedPathsList)}</p>
          <DialogFooter>
            <Button variant="outline" onClick={onProtectedCancel}>
              {COPY.safety.cancel}
            </Button>
            <Button onClick={onProtectedAllow}>{COPY.safety.allow}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
