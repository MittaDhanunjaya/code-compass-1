import { NextResponse } from "next/server";
import { isOfflineMode, isStreamingEnabled } from "@/lib/config";

/**
 * Health check endpoint for API layer.
 * GET /api/health returns a simple status.
 */
export async function GET() {
  const offline = isOfflineMode();
  const streamingEnabled = isStreamingEnabled();
  return NextResponse.json({
    status: offline ? "offline" : "ok",
    app: "code-compass",
    offline: offline,
    streamingEnabled,
  });
}
