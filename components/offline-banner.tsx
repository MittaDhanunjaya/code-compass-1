"use client";

import { useEffect, useState } from "react";

/**
 * Minimal offline banner shown when OFFLINE_MODE=true.
 * Fetches /api/health to determine offline state.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.offline === true) {
          setOffline(true);
        } else if (!cancelled) {
          setOffline(false);
        }
      })
      .catch(() => {
        if (!cancelled) setOffline(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="bg-amber-500/90 text-amber-950 text-center py-1.5 text-sm font-medium">
      Offline mode enabled – remote AI features are disabled.
    </div>
  );
}
