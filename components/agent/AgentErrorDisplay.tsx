"use client";

import { Button } from "@/components/ui/button";
import { ErrorWithAction } from "@/components/error-with-action";

type AgentErrorDisplayProps = {
  error: string | null;
  autoRetryIn: number | null;
  onRetry: () => void;
};

export function AgentErrorDisplay({
  error,
  autoRetryIn,
  onRetry,
}: AgentErrorDisplayProps) {
  if (!error) return null;

  return (
    <div className="space-y-2">
      <ErrorWithAction message={error} />
      {autoRetryIn != null && autoRetryIn > 0 ? (
        <p className="text-sm text-muted-foreground">
          Retrying in {autoRetryIn} second{autoRetryIn !== 1 ? "s" : ""}…
        </p>
      ) : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {autoRetryIn != null ? "Retry now" : "Retry"}
        </Button>
      )}
    </div>
  );
}
