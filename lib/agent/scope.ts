/**
 * Per-run scope: approximate file count and lines changed.
 * Used for visibility (UI) and for conservative/normal/aggressive caps.
 */

import type { FileEditStep, PlanStep } from "./types";

function countLines(text: string): number {
  if (!text || typeof text !== "string") return 0;
  const n = text.split(/\r?\n/).length;
  return n;
}

export type RunScope = {
  fileCount: number;
  approxLinesChanged: number;
  perFile: { path: string; approxLines: number }[];
};

/**
 * Compute approximate scope from file edit steps.
 * approxLines per file = max(lines in oldContent, lines in newContent); if no oldContent, use newContent.
 */
export function computeRunScope(steps: FileEditStep[]): RunScope {
  const fileEdits = steps.filter((s): s is FileEditStep => s.type === "file_edit");
  const perFile: { path: string; approxLines: number }[] = [];
  let approxLinesChanged = 0;

  for (const step of fileEdits) {
    const path = step.path?.trim() || "";
    if (!path) continue;
    const oldLines = countLines(step.oldContent ?? "");
    const newLines = countLines(step.newContent ?? "");
    const approxLines = Math.max(oldLines, newLines);
    perFile.push({ path, approxLines });
    approxLinesChanged += approxLines;
  }

  return {
    fileCount: perFile.length,
    approxLinesChanged,
    perFile,
  };
}

export const MAX_CONSERVATIVE_FILES = 5;
export const MAX_CONSERVATIVE_LINES = 250;

/** ~2–3× normal; used when scopeMode is aggressive. */
export const MAX_AGGRESSIVE_FILES = 15;
export const MAX_AGGRESSIVE_LINES = 750;

export type ScopeMode = "conservative" | "normal" | "aggressive";

/**
 * Trim file_edit steps to meet conservative caps. Keeps steps for paths in preferredPaths first, then by smallest approx lines.
 * Command steps are kept. Returns { steps, trimmed: true, message } if any trimming was done.
 */
export function applyScopeCaps(
  steps: PlanStep[],
  scopeMode: ScopeMode,
  preferredPaths?: Set<string>
): { steps: PlanStep[]; trimmed: boolean; message?: string } {
  if (scopeMode !== "conservative") {
    return { steps, trimmed: false };
  }
  const fileEdits = steps.filter((s): s is FileEditStep => s.type === "file_edit");
  const commandSteps = steps.filter((s) => s.type === "command");
  if (fileEdits.length <= MAX_CONSERVATIVE_FILES) {
    const totalLines = fileEdits.reduce(
      (acc, s) => acc + Math.max(countLines(s.oldContent ?? ""), countLines(s.newContent ?? "")),
      0
    );
    if (totalLines <= MAX_CONSERVATIVE_LINES) return { steps, trimmed: false };
  }

  const withApprox = fileEdits.map((s) => ({
    step: s,
    approx: Math.max(countLines(s.oldContent ?? ""), countLines(s.newContent ?? "")),
  }));
  const preferred = new Set(preferredPaths ?? []);
  withApprox.sort((a, b) => {
    const aPref = preferred.has(a.step.path) ? 1 : 0;
    const bPref = preferred.has(b.step.path) ? 1 : 0;
    if (bPref !== aPref) return bPref - aPref;
    return a.approx - b.approx;
  });

  let kept: FileEditStep[] = [];
  let lines = 0;
  for (const { step, approx } of withApprox) {
    if (kept.length >= MAX_CONSERVATIVE_FILES) break;
    if (lines + approx > MAX_CONSERVATIVE_LINES) break;
    kept.push(step);
    lines += approx;
  }
  const keptPaths = new Set(kept.map((s) => s.path));
  const trimmedSteps: PlanStep[] = [...kept, ...commandSteps];
  const dropped = fileEdits.length - kept.length;
  const message =
    dropped > 0
      ? `Conservative mode: narrowed changes to ${kept.length} file(s), ≈${lines} lines.`
      : undefined;
  return { steps: trimmedSteps, trimmed: dropped > 0, message };
}
