/**
 * Build a tree structure from flat file paths.
 * Paths: "src/app/page.tsx" (file), "src/" (empty folder)
 */

export type FileTreeNode = {
  name: string;
  path: string;
  isFolder: boolean;
  children: FileTreeNode[];
};

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = {
    name: "",
    path: "",
    isFolder: true,
    children: [],
  };

  for (const path of paths) {
    if (!path) continue;

    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    const isFile = !path.endsWith("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const nodePath = parts.slice(0, i + 1).join("/");
      const isFolder = !isLast || path.endsWith("/");

      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: isFolder ? nodePath + "/" : nodePath,
          isFolder,
          children: [],
        };
        current.children.push(child);
      } else if (isLast && isFile) {
        child.isFolder = false;
        child.path = nodePath;
      }
      current = child;
    }
  }

  function sortNodes(nodes: FileTreeNode[]) {
    nodes.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    nodes.forEach((n) => sortNodes(n.children));
  }
  sortNodes(root.children);

  return root.children;
}
