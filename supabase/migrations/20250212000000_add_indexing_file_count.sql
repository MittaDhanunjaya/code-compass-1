-- Add indexing_file_count to workspaces for "Indexed N files" display
ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS indexing_file_count INTEGER DEFAULT 0;

COMMENT ON COLUMN workspaces.indexing_file_count IS 'Number of files indexed when last indexing completed (for UI display).';
