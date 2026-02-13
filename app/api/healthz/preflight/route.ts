import { NextResponse } from "next/server";
import { runPreflightChecks } from "@/lib/preflight";

/**
 * GET /api/healthz/preflight
 * Production safety checks. Returns 200 if all pass, 503 if any fail.
 * Used by load balancers, K8s probes, and startup gate.
 */
export async function GET() {
  const result = await runPreflightChecks();

  if (result.ok) {
    return NextResponse.json(
      {
        status: "ok",
        checks: result.checks.map((c) => ({ name: c.name, ok: c.ok })),
      },
      { status: 200 }
    );
  }

  const failed = result.checks.filter((c) => !c.ok);
  return NextResponse.json(
    {
      status: "degraded",
      message: "Preflight checks failed",
      failed: failed.map((c) => ({ name: c.name, message: c.message })),
      checks: result.checks.map((c) => ({ name: c.name, ok: c.ok, message: c.message })),
    },
    { status: 503 }
  );
}
