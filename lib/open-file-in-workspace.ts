/**
 * Opens a file in the workspace, optionally preferring the diff view when the file
 * has uncommitted (Git) changes. Used by Agent Activity Feed and run summary.
 */

export type OpenFileInWorkspaceOptions = {
  path: string;
  preferDiff?: boolean;
  workspaceId: string;
  openFile: (path: string, content: string) => void;
  getTab: (path: string) => { path: string; content: string; savedContent: string; dirty: boolean } | undefined;
  updateContent: (path: string, content: string) => void;
  setActiveTab: (path: string | null) => void;
};

export const AGENT_REQUEST_DIFF_EVENT = "agent-request-diff";
const DIFF_REQUEST_EVENT = AGENT_REQUEST_DIFF_EVENT;

/**
 * Request that the editor open the diff dialog for the given path.
 * EditorArea listens for this and opens the diff when activeTab matches.
 */
export function requestDiffView(path: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(DIFF_REQUEST_EVENT, { detail: { path } })
  );
}

/**
 * Open a file in the workspace. When preferDiff is true, checks Git status;
 * if the file is modified, opens the file and then requests the diff view.
 * Otherwise opens the file normally. Falls back to normal open on any failure.
 */
export async function openFileInWorkspace(
  options: OpenFileInWorkspaceOptions
): Promise<void> {
  const {
    path,
    preferDiff = false,
    workspaceId,
    openFile,
    getTab,
    updateContent,
    setActiveTab,
  } = options;

  try {
    const fileRes = await fetch(
      `/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`
    );
    if (!fileRes.ok) return;
    const fileData = await fileRes.json();
    const content = fileData.content ?? "";

    const tab = getTab(path);
    if (tab) {
      updateContent(path, content);
      setActiveTab(path);
    } else {
      openFile(path, content);
    }

    if (preferDiff) {
      let shouldOpenDiff = false;
      try {
        const statusRes = await fetch(
          `/api/workspaces/${workspaceId}/git/status`
        );
        if (statusRes.ok) {
          const { entries } = await statusRes.json();
          const modifiedPaths = (entries ?? []).map(
            (e: { path: string }) => e.path
          );
          shouldOpenDiff = modifiedPaths.some(
            (p: string) => p === path || path.endsWith(p) || p.endsWith(path)
          );
        }
      } catch {
        // If git status fails, still open diff if tab is dirty (e.g. after agent edit)
        shouldOpenDiff = getTab(path)?.dirty ?? false;
      }
      if (!shouldOpenDiff) {
        const tabNow = getTab(path);
        shouldOpenDiff = tabNow?.dirty ?? false;
      }
      if (shouldOpenDiff) {
        requestAnimationFrame(() => requestDiffView(path));
      }
    }

    window.dispatchEvent(new CustomEvent("refresh-file-tree"));
  } catch (error) {
    console.warn("Failed to open file:", path, error);
  }
}
