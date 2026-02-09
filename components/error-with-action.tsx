"use client";

import Link from "next/link";

export type ErrorAction = {
  label: string;
  href: string;
};

type ErrorWithActionProps = {
  message: string;
  className?: string;
  /** If not provided, derived from message (API key → Settings, rate limit → Settings / change model). */
  action?: ErrorAction | null;
};

function deriveAction(message: string): ErrorAction | null {
  const lower = message.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("no api key") ||
    lower.includes("add a key") ||
    lower.includes("add key")
  ) {
    return { label: "Add key in Settings", href: "/app/settings?tab=keys" };
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("daily limit") ||
    lower.includes("limit reached")
  ) {
    return { label: "Change model or add key in Settings", href: "/app/settings?tab=keys" };
  }
  if (lower.includes("invalid model") || lower.includes("not a valid model")) {
    return { label: "Change model in dropdown or Settings", href: "/app/settings?tab=keys" };
  }
  if (
    lower.includes("workspace not found") ||
    lower.includes("no workspace") ||
    lower.includes("no active workspace")
  ) {
    return { label: "Select or create a workspace", href: "/app" };
  }
  if (
    lower.includes("github") ||
    lower.includes("repos") ||
    lower.includes("re-import") ||
    lower.includes("connect github")
  ) {
    return { label: "GitHub settings", href: "/app/settings?tab=github" };
  }
  if (lower.includes("protected file") || lower.includes("protected files")) {
    return { label: "Safety settings", href: "/app/settings?tab=safety" };
  }
  if (lower.includes("failed to save") && lower.includes("key")) {
    return { label: "Check API Keys in Settings", href: "/app/settings?tab=keys" };
  }
  return null;
}

export function ErrorWithAction({
  message,
  className = "",
  action: actionProp,
}: ErrorWithActionProps) {
  const action = actionProp ?? deriveAction(message);
  return (
    <div
      className={`rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive ${className}`}
    >
      <span>{message}</span>
      {action && (
        <>
          {" "}
          <Link
            href={action.href}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            {action.label}
          </Link>
        </>
      )}
    </div>
  );
}
