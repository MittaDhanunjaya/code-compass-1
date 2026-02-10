import { NextResponse } from "next/server";
import { APP_VERSION, APP_NAME } from "@/lib/version";

/**
 * Version endpoint for CI and deployment checks.
 * GET /api/version returns app version from package.json.
 */
export async function GET() {
  return NextResponse.json({
    version: APP_VERSION,
    app: APP_NAME,
  });
}
