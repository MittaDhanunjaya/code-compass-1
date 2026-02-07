"use client";

import { useState } from "react";
import Link from "next/link";
import { Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { KeySettingsContent } from "@/components/key-settings-content";

export function KeySettingsDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <Key className="h-4 w-4" />
          API Keys
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API Keys</DialogTitle>
          <DialogDescription>
            Keys are stored encrypted and never sent to the frontend. You can also manage them in{" "}
            <Link
              href="/app/settings?tab=keys"
              className="underline"
              onClick={() => setOpen(false)}
            >
              Settings → API Keys
            </Link>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <KeySettingsContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
