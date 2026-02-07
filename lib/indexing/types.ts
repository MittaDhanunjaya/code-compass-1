/**
 * Types for indexing system (v1).
 */

export type SearchResult = {
  path: string;
  line?: number;
  preview: string;
  score?: number;
};

export type IndexUpdateRequest = {
  workspaceId: string;
  filePaths: string[];
};
