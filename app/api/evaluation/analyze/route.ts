import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/evaluation/analyze
 * Returns aggregated stats for debug-from-log (and sandbox) runs to refine prompts and planning.
 * Call periodically (e.g. cron or nightly) or on-demand to see where the agent tends to fail
 * (by error type, model, repo structure). Use byErrorType and byModel to tune prompts and planning logic.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: runs, error } = await supabase
    .from("sandbox_runs")
    .select("id, source, sandbox_checks_passed, promoted_at, metadata, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const debugRuns = (runs ?? []).filter((r) => r.source === "debug-from-log");
  const byErrorType: Record<string, { total: number; testsPassed: number; promoted: number; rolledBack: number }> = {};
  const byModel: Record<string, { total: number; testsPassed: number; promoted: number }> = {};

  for (const r of debugRuns) {
    const meta = (r.metadata as { error_type?: string; model_used?: string }) ?? {};
    const errorType = meta.error_type ?? "unknown";
    const model = meta.model_used ?? "unknown";
    const testsPassed = r.sandbox_checks_passed === true;
    const promoted = r.promoted_at != null;
    const rolledBack = (r as { user_rolled_back?: boolean }).user_rolled_back === true;

    if (!byErrorType[errorType]) {
      byErrorType[errorType] = { total: 0, testsPassed: 0, promoted: 0, rolledBack: 0 };
    }
    byErrorType[errorType].total += 1;
    if (testsPassed) byErrorType[errorType].testsPassed += 1;
    if (promoted) byErrorType[errorType].promoted += 1;
    if (rolledBack) byErrorType[errorType].rolledBack += 1;

    if (!byModel[model]) {
      byModel[model] = { total: 0, testsPassed: 0, promoted: 0 };
    }
    byModel[model].total += 1;
    if (testsPassed) byModel[model].testsPassed += 1;
    if (promoted) byModel[model].promoted += 1;
  }

  const totalDebug = debugRuns.length;
  const testsPassedCount = debugRuns.filter((r) => r.sandbox_checks_passed === true).length;
  const promotedCount = debugRuns.filter((r) => r.promoted_at != null).length;

  // Time from first error to tests green (promoted_at - created_at or first_error_at)
  const timeToGreenSeconds: number[] = [];
  for (const r of debugRuns) {
    if (!r.promoted_at) continue;
    const start = (r.metadata as { first_error_at?: string })?.first_error_at ?? r.created_at;
    const startMs = new Date(start).getTime();
    const endMs = new Date(r.promoted_at).getTime();
    if (endMs > startMs) timeToGreenSeconds.push(Math.round((endMs - startMs) / 1000));
  }
  const avgTimeToGreen =
    timeToGreenSeconds.length > 0
      ? Math.round(timeToGreenSeconds.reduce((a, b) => a + b, 0) / timeToGreenSeconds.length)
      : null;

  // Possible regression: same error_fingerprint after a promoted run (later run with same fingerprint)
  const promotedFingerprints = new Set(
    debugRuns.filter((r) => r.promoted_at != null).map((r) => (r.metadata as { error_fingerprint?: string })?.error_fingerprint).filter(Boolean)
  );
  const runsWithSameFingerprintAfterPromote = debugRuns.filter((r) => {
    const fp = (r.metadata as { error_fingerprint?: string })?.error_fingerprint;
    return fp && promotedFingerprints.has(fp) && !r.promoted_at && r.created_at;
  }).length;

  return NextResponse.json({
    summary: {
      totalDebugRuns: totalDebug,
      testsPassed: testsPassedCount,
      promoted: promotedCount,
      passRate: totalDebug > 0 ? Math.round((testsPassedCount / totalDebug) * 100) : 0,
      promoteRate: totalDebug > 0 ? Math.round((promotedCount / totalDebug) * 100) : 0,
      avgTimeToGreenSeconds: avgTimeToGreen,
      possibleRegressions: runsWithSameFingerprintAfterPromote,
    },
    byErrorType,
    byModel,
    timeToGreenSeconds: timeToGreenSeconds.length > 0 ? timeToGreenSeconds.slice(0, 50) : undefined,
    hint: "Use byErrorType and byModel to refine prompts and planning; focus on high-total, low passRate segments. avgTimeToGreenSeconds = time from error paste to promote.",
  });
}
