/**
 * Agent edit guardrails: reject or warn when a single edit replaces too much of a file
 * or changes too many lines (e.g. >60% replace ratio or >200 line delta).
 */

import type { FileEditStep } from "./types";

/** Default: flag when replaced portion is >= 40% of file (by lines). Matches OVER_EDIT_RATIO_THRESHOLD. */
export const LARGE_REPLACE_RATIO = 0.4;

/** Default: flag when a single edit adds or removes more than this many lines. */
export const LARGE_REPLACE_ABSOLUTE_LINES = 200;

export type GuardrailMode = "strict" | "warn";

export type GuardrailCheckResult = {
  allowed: boolean;
  overThreshold: boolean;
  reason?: "large_replacement_ratio" | "large_line_delta";
  ratio?: number;
  lineDelta?: number;
  originalLines: number;
  replacedLines: number;
  newLines: number;
};

/**
 * Compute replace ratio and line delta for a file_edit step.
 * - originalContent: current full file content (from workspace).
 * - step.oldContent: snippet being replaced (empty => full replace).
 * - step.newContent: replacement content.
 * Flags when:
 * - Replace ratio (replaced lines / original lines) >= LARGE_REPLACE_RATIO, or
 * - Absolute line delta (|newLines - replacedLines|) > LARGE_REPLACE_ABSOLUTE_LINES.
 */
export function checkEditGuardrail(
  originalContent: string,
  step: FileEditStep,
  options: {
    ratioThreshold?: number;
    lineDeltaThreshold?: number;
  } = {}
): GuardrailCheckResult {
  const ratioThreshold = options.ratioThreshold ?? LARGE_REPLACE_RATIO;
  const lineDeltaThreshold = options.lineDeltaThreshold ?? LARGE_REPLACE_ABSOLUTE_LINES;

  const originalLines = originalContent.split("\n").length;
  const isFullReplace = !step.oldContent || step.oldContent.trim() === "";
  const replacedLines = isFullReplace
    ? originalLines
    : step.oldContent!.split("\n").length;
  const newLines = step.newContent.split("\n").length;

  const ratio = originalLines > 0 ? replacedLines / originalLines : 0;
  const lineDelta = newLines - replacedLines;
  const absLineDelta = Math.abs(lineDelta);

  const overRatio = ratio >= ratioThreshold;
  const overLineDelta = absLineDelta > lineDeltaThreshold;
  const overThreshold = overRatio || overLineDelta;

  const reason =
    overRatio && overLineDelta
      ? "large_replacement_ratio"
      : overRatio
        ? "large_replacement_ratio"
        : overLineDelta
          ? "large_line_delta"
          : undefined;

  return {
    allowed: true,
    overThreshold,
    reason,
    ratio: overRatio ? ratio : undefined,
    lineDelta: overLineDelta ? lineDelta : undefined,
    originalLines,
    replacedLines,
    newLines,
  };
}

/**
 * Resolve guardrail mode: env AGENT_GUARDRAIL_MODE (strict|warn) or default 'warn'.
 */
export function getGuardrailMode(): GuardrailMode {
  const v = process.env.AGENT_GUARDRAIL_MODE?.toLowerCase();
  if (v === "strict" || v === "warn") return v;
  return "warn";
}
