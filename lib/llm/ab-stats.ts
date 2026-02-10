/**
 * A/B and fallback: record patch outcomes, prefer the model that wins more.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type OutcomeType = "win" | "loss" | "timeout" | "malformed";

export type RecordOutcomeInput = {
  userId: string;
  taskType: string;
  modelId: string;
  providerId: string;
  outcome: OutcomeType;
  editSizeDelta?: number;
  sandboxChecksPassed?: boolean;
};

/**
 * Record the outcome of a model run (e.g. patch A/B). Call after comparing
 * two models or after a single run (outcome win/loss/timeout/malformed).
 */
export async function recordModelOutcome(
  supabase: SupabaseClient,
  input: RecordOutcomeInput
): Promise<void> {
  await supabase.from("model_run_outcomes").insert({
    user_id: input.userId,
    task_type: input.taskType,
    model_id: input.modelId,
    provider_id: input.providerId,
    outcome: input.outcome,
    edit_size_delta: input.editSizeDelta ?? null,
    sandbox_checks_passed: input.sandboxChecksPassed ?? null,
  });
}

export type ModelStats = {
  modelId: string;
  providerId: string;
  wins: number;
  losses: number;
  timeouts: number;
  malformed: number;
  total: number;
  winRate: number;
};

/**
 * Get win/loss stats per model for a task type (e.g. "patch"). Use to pick
 * the preferred model; fallback to the other on timeout or malformed.
 */
export async function getModelStats(
  supabase: SupabaseClient,
  userId: string,
  taskType: string,
  limit = 500
): Promise<ModelStats[]> {
  const { data, error } = await supabase
    .from("model_run_outcomes")
    .select("model_id, provider_id, outcome")
    .eq("user_id", userId)
    .eq("task_type", taskType)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return [];

  const SEP = "\0";
  const byModel = new Map<string, { wins: number; losses: number; timeouts: number; malformed: number }>();
  for (const row of data ?? []) {
    const key = `${row.provider_id}${SEP}${row.model_id}`;
    const cur = byModel.get(key) ?? { wins: 0, losses: 0, timeouts: 0, malformed: 0 };
    if (row.outcome === "win") cur.wins++;
    else if (row.outcome === "loss") cur.losses++;
    else if (row.outcome === "timeout") cur.timeouts++;
    else if (row.outcome === "malformed") cur.malformed++;
    byModel.set(key, cur);
  }

  const result: ModelStats[] = [];
  for (const [key, counts] of byModel) {
    const idx = key.indexOf(SEP);
    const providerId = idx >= 0 ? key.slice(0, idx) : "openrouter";
    const modelId = idx >= 0 ? key.slice(idx + 1) : key;
    const total = counts.wins + counts.losses + counts.timeouts + counts.malformed;
    result.push({
      modelId,
      providerId,
      wins: counts.wins,
      losses: counts.losses,
      timeouts: counts.timeouts,
      malformed: counts.malformed,
      total,
      winRate: total > 0 ? counts.wins / total : 0,
    });
  }
  result.sort((a, b) => b.winRate - a.winRate);
  return result;
}

/**
 * Get the preferred model for a task (highest win rate). Returns undefined if no data.
 */
export async function getPreferredModel(
  supabase: SupabaseClient,
  userId: string,
  taskType: string
): Promise<{ providerId: string; modelId: string } | undefined> {
  const stats = await getModelStats(supabase, userId, taskType, 300);
  const best = stats[0];
  if (!best || best.total < 2) return undefined;
  return { providerId: best.providerId, modelId: best.modelId };
}

export type PatchModelCandidate = { providerId: string; modelId: string };

/**
 * Return [primary, fallback] for patch/debug tasks. Used for A/B fallback:
 * try primary first; on timeout/malformed/404 try fallback. Prefer model with better win rate when available.
 */
export async function getPatchModelCandidates(
  supabase: SupabaseClient,
  userId: string,
  taskType: "patch" | "debug" = "patch"
): Promise<PatchModelCandidate[]> {
  const { getModelForTask } = await import("./task-routing");
  const preferred = await getPreferredModel(supabase, userId, taskType);
  const taskModel = getModelForTask(taskType);
  const taskPatch = getModelForTask("patch");
  const primary: PatchModelCandidate = preferred ?? {
    providerId: taskModel.providerId,
    modelId: taskModel.model ?? "openrouter/free",
  };
  let fallback: PatchModelCandidate = {
    providerId: taskPatch.providerId,
    modelId: taskPatch.model ?? "openrouter/free",
  };
  if (primary.providerId === fallback.providerId && primary.modelId === fallback.modelId) {
    const taskDebug = getModelForTask("debug");
    fallback = {
      providerId: taskDebug.providerId,
      modelId: taskDebug.model ?? "openrouter/free",
    };
  }
  return [primary, fallback];
}
