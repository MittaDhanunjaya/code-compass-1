import { NextResponse } from "next/server";

/**
 * Health check endpoint for API layer.
 * GET /api/health returns a simple status.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    app: "AIForge",
  });
}
