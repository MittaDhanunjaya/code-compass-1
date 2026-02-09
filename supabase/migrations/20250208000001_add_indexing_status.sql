-- Add indexing status columns to workspaces table
ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS indexing_status TEXT DEFAULT 'idle',
ADD COLUMN IF NOT EXISTS indexing_progress INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS indexing_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS indexing_completed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS indexing_error TEXT;

-- Index for efficient status queries
CREATE INDEX IF NOT EXISTS idx_workspaces_indexing_status ON workspaces(indexing_status);
