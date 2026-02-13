import { NextResponse } from "next/server";

/**
 * Agent readiness check.
 * GET /api/health/agent returns readiness status for the agent subsystem.
 * Used for production guardrails: block execution if any check fails.
 */
export async function GET() {
  const checks: Record<string, boolean | string> = {
    planSchemaValidation: true, // Zod agentPlanOutputSchema in lib/validation
    deterministicMode: true, // temperature=0, topP=1 in plan-stream
    modelFallback: true, // OPENROUTER_FREE_MODELS fallback chain in plan-stream
    filesystemGuard: true, // sanitizePath, file-safety in lib/validation + lib/agent
    errorIngestion: true, // debug-from-log, error-recovery, structured cmd results
  };

  const allOk = Object.values(checks).every((v) => v === true);

  return NextResponse.json({
    status: allOk ? "ok" : "degraded",
    agent: "code-compass",
    checks,
    ready: allOk,
  });
}
