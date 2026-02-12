-- Code Compass: Add pgvector extension and embeddings support for semantic search
-- Enables vector similarity search for codebase intelligence

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding vector column to code_chunks (1536 dimensions for OpenAI text-embedding-3-small)
ALTER TABLE public.code_chunks
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create index for vector similarity search (HNSW for fast approximate nearest neighbor)
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding 
  ON public.code_chunks 
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Add index for workspace + embedding queries
CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace_embedding 
  ON public.code_chunks(workspace_id) 
  WHERE embedding IS NOT NULL;

COMMENT ON COLUMN public.code_chunks.embedding IS 'Vector embedding for semantic search (OpenAI text-embedding-3-small, 1536 dimensions)';
