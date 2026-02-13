"use client";

import { useEffect, useState } from "react";

export type HealthConfig = {
  offline: boolean;
  streamingEnabled: boolean;
};

/**
 * Fetches /api/health for offline and streamingEnabled flags.
 * Used to disable streaming UI when STREAMING_ENABLED=false.
 */
export function useHealthConfig(): HealthConfig {
  const [config, setConfig] = useState<HealthConfig>({
    offline: false,
    streamingEnabled: true,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setConfig({
            offline: data?.offline === true,
            streamingEnabled: data?.streamingEnabled !== false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfig({ offline: false, streamingEnabled: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
