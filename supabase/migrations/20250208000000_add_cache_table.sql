-- Persistent cache table for caching Tab completions, search results, and embeddings
CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient expiration cleanup
CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache_entries(expires_at);

-- Function to automatically clean up expired entries
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS void AS $$
BEGIN
  DELETE FROM cache_entries WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
