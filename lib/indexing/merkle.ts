/**
 * Merkle tree implementation for efficient incremental indexing.
 * Detects changed files without re-indexing entire codebase.
 */

import crypto from "crypto";

export type MerkleNode = {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  filePath?: string; // Leaf nodes only
  contentHash?: string; // Leaf nodes only
};

/**
 * Compute hash of content.
 */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Build Merkle tree from file hashes.
 */
export function buildMerkleTree(
  files: Array<{ path: string; content: string }>
): MerkleNode {
  if (files.length === 0) {
    return { hash: hashContent("") };
  }

  if (files.length === 1) {
    const contentHash = hashContent(files[0].content);
    return {
      hash: hashContent(`${files[0].path}:${contentHash}`),
      filePath: files[0].path,
      contentHash,
    };
  }

  // Build leaf nodes
  const leaves: MerkleNode[] = files.map((file) => {
    const contentHash = hashContent(file.content);
    return {
      hash: hashContent(`${file.path}:${contentHash}`),
      filePath: file.path,
      contentHash,
    };
  });

  // Build tree bottom-up
  let currentLevel = leaves;
  while (currentLevel.length > 1) {
    const nextLevel: MerkleNode[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left; // Duplicate last node if odd
      nextLevel.push({
        hash: hashContent(`${left.hash}:${right.hash}`),
        left,
        right,
      });
    }
    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

/**
 * Get Merkle root hash.
 */
export function getMerkleRoot(node: MerkleNode): string {
  return node.hash;
}

/**
 * Find changed files by comparing Merkle trees.
 * Returns paths of files that changed.
 */
export function findChangedFiles(
  oldTree: MerkleNode,
  newFiles: Array<{ path: string; content: string }>
): string[] {
  const changed: string[] = [];
  const newTree = buildMerkleTree(newFiles);

  // If roots match, no changes
  if (oldTree.hash === newTree.hash) {
    return [];
  }

  // Build file map from new files
  const newFileMap = new Map(
    newFiles.map((f) => [f.path, hashContent(f.content)])
  );

  // Traverse old tree to find changed files
  function traverse(node: MerkleNode, oldFileMap: Map<string, string>) {
    if (node.filePath) {
      // Leaf node
      const newHash = newFileMap.get(node.filePath);
      if (!newHash || newHash !== node.contentHash) {
        changed.push(node.filePath);
      }
      return;
    }

    if (node.left) traverse(node.left, oldFileMap);
    if (node.right) traverse(node.right, oldFileMap);
  }

  // Build old file map from tree
  const oldFileMap = new Map<string, string>();
  function buildOldMap(node: MerkleNode) {
    if (node.filePath && node.contentHash) {
      oldFileMap.set(node.filePath, node.contentHash);
      return;
    }
    if (node.left) buildOldMap(node.left);
    if (node.right) buildOldMap(node.right);
  }
  buildOldMap(oldTree);

  // Find changed files
  traverse(oldTree, oldFileMap);

  // Also check for new files
  for (const file of newFiles) {
    if (!oldFileMap.has(file.path)) {
      changed.push(file.path);
    }
  }

  return [...new Set(changed)]; // Deduplicate
}

/**
 * Serialize Merkle tree to JSON for storage.
 */
export function serializeMerkleTree(node: MerkleNode): string {
  return JSON.stringify({
    hash: node.hash,
    filePath: node.filePath,
    contentHash: node.contentHash,
    left: node.left ? serializeMerkleTree(node.left) : undefined,
    right: node.right ? serializeMerkleTree(node.right) : undefined,
  });
}

/**
 * Deserialize Merkle tree from JSON.
 */
export function deserializeMerkleTree(json: string): MerkleNode {
  const data = JSON.parse(json);
  return {
    hash: data.hash,
    filePath: data.filePath,
    contentHash: data.contentHash,
    left: data.left ? deserializeMerkleTree(data.left) : undefined,
    right: data.right ? deserializeMerkleTree(data.right) : undefined,
  };
}
