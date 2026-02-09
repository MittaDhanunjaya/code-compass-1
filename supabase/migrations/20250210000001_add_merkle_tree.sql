-- AIForge: Add Merkle tree storage for efficient incremental indexing
-- Stores workspace Merkle root for change detection

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS merkle_root TEXT,
  ADD COLUMN IF NOT EXISTS merkle_tree_json JSONB;

CREATE INDEX IF NOT EXISTS idx_workspaces_merkle_root ON public.workspaces(merkle_root) WHERE merkle_root IS NOT NULL;

COMMENT ON COLUMN public.workspaces.merkle_root IS 'Merkle root hash for efficient change detection';
COMMENT ON COLUMN public.workspaces.merkle_tree_json IS 'Serialized Merkle tree structure for incremental updates';
