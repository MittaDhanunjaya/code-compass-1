-- Phase 4.1.1: Add indexes on user_id, workspace_id, created_at where missing
-- Phase 4.1.2: Most FKs already exist; workspace members has them
-- Phase 4.1.3: Add embedding cache for deduplication (hash content before re-embedding)

-- 4.1.1: Missing indexes
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON public.feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_workspace_id ON public.feedback(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_created ON public.workspaces(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace_created ON public.code_chunks(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON public.chat_messages(created_at DESC);

-- 4.1.3: Embedding cache for deduplication - reuse embeddings for identical content
-- content_hash = hash of chunk text; embedding stored once per unique content
CREATE TABLE IF NOT EXISTS public.embedding_cache (
  content_hash TEXT PRIMARY KEY,
  embedding vector(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for vector ops if we ever need to query by embedding (optional)
CREATE INDEX IF NOT EXISTS idx_embedding_cache_created ON public.embedding_cache(created_at);

ALTER TABLE public.embedding_cache ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read/write during indexing (cache is content-based, not user-specific)
CREATE POLICY "Authenticated users can use embedding cache"
  ON public.embedding_cache
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

COMMENT ON TABLE public.embedding_cache IS 'Cache for embedding deduplication: content_hash -> embedding. Reduces API calls when same content appears in multiple chunks.';

-- Phase 4.2.1: Per-user daily token budget tracking
CREATE TABLE IF NOT EXISTS public.token_usage_daily (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_token_usage_daily_user_date ON public.token_usage_daily(user_id, date);

ALTER TABLE public.token_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own token usage"
  ON public.token_usage_daily
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.token_usage_daily IS 'Phase 4.2.1: Per-user daily token budget. Backend increments tokens_used. Check before LLM call.';

-- Phase 4.2.3: Per-workspace daily token limit (optional)
CREATE TABLE IF NOT EXISTS public.token_usage_workspace_daily (
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, date)
);

CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_daily_ws_date ON public.token_usage_workspace_daily(workspace_id, date);

ALTER TABLE public.token_usage_workspace_daily ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace owners can manage workspace token usage"
  ON public.token_usage_workspace_daily
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.owner_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.increment_token_usage_workspace(
  p_workspace_id UUID,
  p_date DATE,
  p_tokens INTEGER
)
RETURNS void AS $$
BEGIN
  INSERT INTO public.token_usage_workspace_daily (workspace_id, date, tokens_used, updated_at)
  VALUES (p_workspace_id, p_date, p_tokens, NOW())
  ON CONFLICT (workspace_id, date)
  DO UPDATE SET
    tokens_used = public.token_usage_workspace_daily.tokens_used + EXCLUDED.tokens_used,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.token_usage_workspace_daily IS 'Phase 4.2.3: Per-workspace daily token limit. Optional.';

-- Atomic increment for token usage
CREATE OR REPLACE FUNCTION public.increment_token_usage(
  p_user_id UUID,
  p_date DATE,
  p_tokens INTEGER
)
RETURNS void AS $$
BEGIN
  INSERT INTO public.token_usage_daily (user_id, date, tokens_used, updated_at)
  VALUES (p_user_id, p_date, p_tokens, NOW())
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    tokens_used = public.token_usage_daily.tokens_used + EXCLUDED.tokens_used,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
