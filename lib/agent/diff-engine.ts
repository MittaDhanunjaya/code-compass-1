/**
 * Shared diff/merge for Agent (and later Composer) edits.
 * Applies an edit (oldContent -> newContent) to current file content.
 * If oldContent is not found, attempts to re-anchor using a unique snippet.
 */

export type ApplyEditResult =
  | { ok: true; content: string; reanchored?: boolean }
  | { ok: false; error: string };

/**
 * Try to find a unique anchor (contiguous lines from oldContent) in currentContent.
 * Returns index, the anchor string (to compute length in currentContent), and replacement.
 */
function tryReanchor(
  currentContent: string,
  oldContent: string,
  newContent: string
): { index: number; anchor: string; replacement: string } | null {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  if (oldLines.length === 0) return null;
  const minAnchor = 2;
  const maxAnchor = Math.min(8, oldLines.length);
  for (let len = maxAnchor; len >= minAnchor; len--) {
    const start = Math.floor((oldLines.length - len) / 2);
    const anchor = oldLines.slice(start, start + len).join("\n");
    if (anchor.length < 10) continue;
    const first = currentContent.indexOf(anchor);
    if (first === -1) continue;
    const second = currentContent.indexOf(anchor, first + 1);
    if (second !== -1) continue;
    const replacement = newLines.slice(start, start + len).join("\n");
    return { index: first, anchor, replacement };
  }
  return null;
}

/**
 * Apply a single edit to current file content.
 * - If oldContent is provided: replace the first occurrence of oldContent with newContent.
 *   If not found, tries to re-anchor: find a unique snippet from oldContent in currentContent
 *   and replace it with the corresponding lines from newContent (so small user changes nearby
 *   don't cause a full conflict).
 * - If oldContent is omitted/empty: full replace — content becomes newContent.
 */
export function applyEdit(
  currentContent: string,
  newContent: string,
  oldContent?: string
): ApplyEditResult {
  if (oldContent === undefined || oldContent === "") {
    return { ok: true, content: newContent };
  }

  const index = currentContent.indexOf(oldContent);
  if (index !== -1) {
    const content =
      currentContent.slice(0, index) +
      newContent +
      currentContent.slice(index + oldContent.length);
    return { ok: true, content };
  }

  const reanchorResult = tryReanchor(currentContent, oldContent, newContent);
  if (reanchorResult) {
    const anchorLength = reanchorResult.anchor.length;
    const content =
      currentContent.slice(0, reanchorResult.index) +
      reanchorResult.replacement +
      currentContent.slice(reanchorResult.index + anchorLength);
    return { ok: true, content, reanchored: true };
  }

  return {
    ok: false,
    error: "Edit block not found in current file (file may have changed).",
  };
}
