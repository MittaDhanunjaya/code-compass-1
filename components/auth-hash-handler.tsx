"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Handles Supabase auth redirects that use the implicit flow (tokens in URL hash).
 * The hash is never sent to the server, so we must process it client-side.
 * Our createBrowserClient uses PKCE and rejects implicit URLs, so we manually
 * extract tokens and call setSession. When user lands on /#access_token=...&type=recovery,
 * we establish the session and redirect to /reset-password.
 */
export function AuthHashHandler() {
  const router = useRouter();

  useEffect(() => {
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (!hash) {
      router.replace("/sign-in");
      return;
    }

    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const type = params.get("type");

    if (!accessToken || !refreshToken) {
      router.replace("/sign-in");
      return;
    }

    const supabase = createClient();
    const next = type === "recovery" ? "/reset-password" : "/app";

    let cancelled = false;
    supabase.auth
      .setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      })
      .then(({ error }) => {
        if (cancelled) return;
        if (error) {
          router.replace("/sign-in?error=auth_callback_error");
          return;
        }
        // Clear hash from URL
        window.history.replaceState(null, "", window.location.pathname);
        router.replace(next);
      })
      .catch(() => {
        if (!cancelled) router.replace("/sign-in?error=auth_callback_error");
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">Completing sign in…</p>
    </div>
  );
}
