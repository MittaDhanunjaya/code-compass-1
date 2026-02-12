-- Code Compass: Add vector similarity search function for semantic code search
-- Uses pgvector cosine distance for finding similar code chunks

CREATE OR REPLACE FUNCTION match_code_chunks(
  query_embedding vector(1536),
  match_workspace_id UUID,
  match_threshold float DEFAULT 0.7,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  workspace_id UUID,
  file_path TEXT,
  chunk_index INTEGER,
  content TEXT,
  symbols JSONB,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    code_chunks.id,
    code_chunks.workspace_id,
    code_chunks.file_path,
    code_chunks.chunk_index,
    code_chunks.content,
    code_chunks.symbols,
    1 - (code_chunks.embedding <=> query_embedding) as similarity
  FROM code_chunks
  WHERE code_chunks.workspace_id = match_workspace_id
    AND code_chunks.embedding IS NOT NULL
    AND 1 - (code_chunks.embedding <=> query_embedding) > match_threshold
  ORDER BY code_chunks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_code_chunks IS 'Semantic search function using vector similarity. Returns code chunks sorted by cosine similarity to query embedding.';
