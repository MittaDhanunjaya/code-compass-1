/**
 * Evaluation service. Aggregates debug-from-log and sandbox run stats.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { EVAL_TASKS, type EvalTask } from "@/lib/eval/tasks";

export type SandboxRunRow = {
  id: string;
  source: string | null;
  sandbox_checks_passed: boolean | null;
  promoted_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type ByErrorTypeEntry = {
  total: number;
  testsPassed: number;
  promoted: number;
  rolledBack: number;
};

export type ByModelEntry = {
  total: number;
  testsPassed: number;
  promoted: number;
};

export type AnalyzeResult = {
  summary: {
    totalDebugRuns: number;
    testsPassed: number;
    promoted: number;
    passRate: number;
    promoteRate: number;
    avgTimeToGreenSeconds: number | null;
    possibleRegressions: number;
  };
  byErrorType: Record<string, ByErrorTypeEntry>;
  byModel: Record<string, ByModelEntry>;
  timeToGreenSeconds?: number[];
  hint: string;
};

/**
 * Aggregate debug-from-log stats from sandbox_runs for the given user.
 */
export async function aggregateDebugFromLogStats(
  supabase: SupabaseClient,
  userId: string
): Promise<AnalyzeResult> {
  const { data: runs, error } = await supabase
    .from("sandbox_runs")
    .select("id, source, sandbox_checks_passed, promoted_at, metadata, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    throw new Error(error.message);
  }

  const debugRuns = (runs ?? []).filter((r: SandboxRunRow) => r.source === "debug-from-log");
  const byErrorType: Record<string, ByErrorTypeEntry> = {};
  const byModel: Record<string, ByModelEntry> = {};

  for (const r of debugRuns) {
    const meta = ((r.metadata ?? {}) as { error_type?: string; model_used?: string; user_rolled_back?: boolean }) ?? {};
    const errorType = meta.error_type ?? "unknown";
    const model = meta.model_used ?? "unknown";
    const testsPassed = r.sandbox_checks_passed === true;
    const promoted = r.promoted_at != null;
    const rolledBack = meta.user_rolled_back === true;

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
  const testsPassedCount = debugRuns.filter((r: SandboxRunRow) => r.sandbox_checks_passed === true).length;
  const promotedCount = debugRuns.filter((r: SandboxRunRow) => r.promoted_at != null).length;

  const timeToGreenSeconds: number[] = [];
  for (const r of debugRuns) {
    if (!r.promoted_at) continue;
    const start = ((r.metadata ?? {}) as { first_error_at?: string })?.first_error_at ?? r.created_at;
    const startMs = new Date(start).getTime();
    const endMs = new Date(r.promoted_at).getTime();
    if (endMs > startMs) timeToGreenSeconds.push(Math.round((endMs - startMs) / 1000));
  }
  const avgTimeToGreen =
    timeToGreenSeconds.length > 0
      ? Math.round(timeToGreenSeconds.reduce((a, b) => a + b, 0) / timeToGreenSeconds.length)
      : null;

  const promotedFingerprints = new Set(
    debugRuns
      .filter((r: SandboxRunRow) => r.promoted_at != null)
      .map((r: SandboxRunRow) => ((r.metadata ?? {}) as { error_fingerprint?: string })?.error_fingerprint)
      .filter(Boolean)
  );
  const runsWithSameFingerprintAfterPromote = debugRuns.filter((r: SandboxRunRow) => {
    const fp = ((r.metadata ?? {}) as { error_fingerprint?: string })?.error_fingerprint;
    return fp && promotedFingerprints.has(fp) && !r.promoted_at && r.created_at;
  }).length;

  return {
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
    hint:
      "Use byErrorType and byModel to refine prompts and planning; focus on high-total, low passRate segments. avgTimeToGreenSeconds = time from error paste to promote.",
  };
}

/**
 * Return the list of synthetic eval tasks for the eval suite.
 */
export function getEvalTasks(): { tasks: EvalTask[]; hint: string } {
  return {
    tasks: EVAL_TASKS,
    hint:
      "Use these task IDs with the agent (e.g. paste instruction) or with scripts/run-eval to run the suite and compare models.",
  };
}
