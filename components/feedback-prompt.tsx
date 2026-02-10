"use client";

import { Button } from "@/components/ui/button";

type Source = "agent" | "composer" | "debug";

export function FeedbackPrompt({
  source,
  workspaceId,
  onSubmitted,
  className,
}: {
  source: Source;
  workspaceId: string | null;
  onSubmitted: () => void;
  className?: string;
}) {
  const submit = (helpful: boolean) => {
    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, source, helpful }),
    }).catch(() => {});
    onSubmitted();
  };

  return (
    <div className={`flex items-center gap-2 text-xs text-muted-foreground ${className ?? ""}`}>
      <span>Did this change help?</span>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => submit(true)}>
        Yes
      </Button>
      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => submit(false)}>
        No
      </Button>
    </div>
  );
}
