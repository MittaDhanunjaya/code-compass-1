/**
 * Per-request provider/model availability tracking.
 * Mark provider+model unavailable when quota/rate-limit hit; skip for remainder of request.
 */

import type { ProviderId } from "./providers";

export type UnavailabilityReason = "quota_exceeded" | "rate_limited" | "invalid_key";

export type ProviderAvailability = {
  providerId: ProviderId;
  model: string;
  available: boolean;
  reason?: UnavailabilityReason;
};

/** In-memory tracker for a single request. */
export type ProviderAvailabilityTracker = Map<string, ProviderAvailability>;

function key(providerId: ProviderId, model: string): string {
  return `${providerId}:${model}`;
}

export function createProviderAvailabilityTracker(): ProviderAvailabilityTracker {
  return new Map();
}

export function markUnavailable(
  tracker: ProviderAvailabilityTracker,
  providerId: ProviderId,
  model: string,
  reason: UnavailabilityReason
): void {
  tracker.set(key(providerId, model), {
    providerId,
    model,
    available: false,
    reason,
  });
}

export function isMarkedUnavailable(
  tracker: ProviderAvailabilityTracker,
  providerId: ProviderId,
  model: string
): boolean {
  const entry = tracker.get(key(providerId, model));
  return entry !== undefined && !entry.available;
}

export function getAvailablePairs<T extends { providerId: ProviderId; apiKey: string; model?: string | null }>(
  tracker: ProviderAvailabilityTracker,
  pairs: T[],
  getModel: (p: T) => string
): T[] {
  return pairs.filter((p) => !isMarkedUnavailable(tracker, p.providerId, getModel(p)));
}
