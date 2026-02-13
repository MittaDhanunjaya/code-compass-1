/**
 * Auto-assign swarm roles (planner, coder, reviewer) based on model characteristics.
 * Used when user selects models but doesn't know which is best for each role.
 */

export type SwarmRole = "planner" | "coder" | "reviewer";

export interface ModelForRole {
  id: string;
  label: string;
  modelSlug?: string;
}

/** Score 0–2: how well this model fits the role. Higher = better. */
function scoreForPlanner(m: ModelForRole): number {
  const s = (m.modelSlug ?? "").toLowerCase();
  const l = (m.label ?? "").toLowerCase();
  const combined = `${s} ${l}`;
  let score = 0;
  // Reasoning / planning models
  if (/\br1\b|r1t|chimera|reasoning|step-?3\.?5/.test(combined)) score += 2;
  else if (/deepseek-r1|r1-05/.test(combined)) score += 2;
  else if (/trinity|aurora|agentic/.test(combined)) score += 1;
  // Coder models are weaker for planning (structured JSON)
  if (/coder/.test(combined)) score -= 1;
  return Math.max(0, score);
}

/** Score 0–2: how well this model fits the coder role. */
function scoreForCoder(m: ModelForRole): number {
  const s = (m.modelSlug ?? "").toLowerCase();
  const l = (m.label ?? "").toLowerCase();
  const combined = `${s} ${l}`;
  let score = 0;
  // Explicit coding models
  if (/coder|aurora/.test(combined)) score += 2;
  else if (/trinity|agentic|chat-v3|gemini|gpt-4|claude/.test(combined)) score += 1;
  // Pure reasoning models are weaker for code gen
  if (/\br1\b|r1t|chimera|reasoning/.test(combined) && !/coder/.test(combined)) score -= 1;
  return Math.max(0, score);
}

/** Score 0–2: how well this model fits the reviewer role (quality, subtlety). */
function scoreForReviewer(m: ModelForRole): number {
  const s = (m.modelSlug ?? "").toLowerCase();
  const l = (m.label ?? "").toLowerCase();
  const combined = `${s} ${l}`;
  let score = 0;
  // Larger / quality models
  if (/sonnet|gpt-4o|70b|90b|120b|480b|pro\b/.test(combined)) score += 2;
  else if (/haiku|flash|mini|7b|3b/.test(combined)) score += 0;
  else score += 1;
  return Math.max(0, score);
}

/**
 * Auto-assign roles to selected models. Returns ordered list: planner first, then coder, then reviewer, then fill remaining as coder.
 */
export function suggestRoleAssignments(models: ModelForRole[]): { modelId: string; role: SwarmRole }[] {
  if (models.length === 0) return [];
  if (models.length === 1) {
    return [{ modelId: models[0].id, role: "planner" }];
  }

  const scored = models.map((m) => ({
    m,
    planner: scoreForPlanner(m),
    coder: scoreForCoder(m),
    reviewer: scoreForReviewer(m),
  }));

  const assigned = new Set<string>();
  const result: { modelId: string; role: SwarmRole }[] = [];

  function pickBestFor(role: SwarmRole): ModelForRole | null {
    const scoreKey = role === "planner" ? "planner" : role === "coder" ? "coder" : "reviewer";
    let best: (typeof scored)[0] | null = null;
    let bestScore = -1;
    for (const s of scored) {
      if (assigned.has(s.m.id)) continue;
      const sc = s[scoreKey];
      if (sc > bestScore) {
        bestScore = sc;
        best = s;
      }
    }
    if (best) {
      assigned.add(best.m.id);
      return best.m;
    }
    return null;
  }

  function pickAnyUnassigned(): ModelForRole | null {
    for (const s of scored) {
      if (!assigned.has(s.m.id)) return s.m;
    }
    return null;
  }

  // 1. Assign planner
  const planner = pickBestFor("planner") ?? pickAnyUnassigned();
  if (planner) {
    result.push({ modelId: planner.id, role: "planner" });
  }

  // 2. Assign coder
  const coder = pickBestFor("coder") ?? pickAnyUnassigned();
  if (coder) {
    result.push({ modelId: coder.id, role: "coder" });
  }

  // 3. Assign reviewer (if we have 3+)
  if (models.length >= 3) {
    const reviewer = pickBestFor("reviewer") ?? pickAnyUnassigned();
    if (reviewer) {
      result.push({ modelId: reviewer.id, role: "reviewer" });
    }
  }

  // 4. Remaining models → coder
  let remaining = pickAnyUnassigned();
  while (remaining) {
    result.push({ modelId: remaining.id, role: "coder" });
    remaining = pickAnyUnassigned();
  }

  return result;
}
