-- Code Compass: Basic indexing tables for codebase intelligence (v1)
-- Stores file chunks and symbol information for TS/JS files

-- code_chunks: indexed chunks of file content
CREATE TABLE IF NOT EXISTS public.code_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  symbols JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, file_path, chunk_index)
);

-- file_index_metadata: tracks which files are indexed and their hash
CREATE TABLE IF NOT EXISTS public.file_index_metadata (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, file_path)
);

-- Indexes for search performance
CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace_id ON public.code_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_file_path ON public.code_chunks(workspace_id, file_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_content_search ON public.code_chunks USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_file_index_metadata_workspace_id ON public.file_index_metadata(workspace_id);

-- RLS: enable Row Level Security
ALTER TABLE public.code_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_index_metadata ENABLE ROW LEVEL SECURITY;

-- code_chunks: users can only access chunks in workspaces they own
CREATE POLICY "Users can access chunks in own workspaces"
  ON public.code_chunks
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  );

-- file_index_metadata: users can only access metadata in workspaces they own
CREATE POLICY "Users can access metadata in own workspaces"
  ON public.file_index_metadata
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  );
