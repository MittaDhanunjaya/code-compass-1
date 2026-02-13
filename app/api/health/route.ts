import { NextResponse } from "next/server";
import { isOfflineMode, isStreamingEnabled, isDeterministicPlanning } from "@/lib/config";

/**
 * Health check endpoint for API layer.
 * GET /api/health returns a simple status.
 */
export async function GET() {
  const offline = isOfflineMode();
  const streamingEnabled = isStreamingEnabled();
  const deterministicPlanning = isDeterministicPlanning();
  return NextResponse.json({
    status: offline ? "offline" : "ok",
    app: "code-compass",
    offline: offline,
    streamingEnabled,
    deterministicPlanning,
  });
}
