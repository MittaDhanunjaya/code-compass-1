/**
 * Phase 12.2.4: Metrics endpoint for observability.
 * Returns JSON summary of in-memory metrics (LLM latency, agent timing).
 * Auth: Required (sensitive internal data).
 */

import { NextResponse } from "next/server";
import { getMetricsSnapshot } from "@/lib/metrics";
import { requireAuth, withAuthResponse } from "@/lib/auth/require-auth";

export async function GET(request: Request) {
  try {
    await requireAuth(request);
  } catch (e) {
    const res = withAuthResponse(e);
    if (res) return res;
    throw e;
  }

  const snapshot = getMetricsSnapshot();
  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
