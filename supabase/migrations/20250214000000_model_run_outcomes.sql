-- A/B and fallback: store patch outcomes to prefer the model that wins more
CREATE TABLE IF NOT EXISTS public.model_run_outcomes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL DEFAULT 'patch',
  model_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'timeout', 'malformed')),
  edit_size_delta INT,
  sandbox_checks_passed BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_run_outcomes_user_task ON public.model_run_outcomes(user_id, task_type);
CREATE INDEX IF NOT EXISTS idx_model_run_outcomes_created ON public.model_run_outcomes(created_at DESC);

ALTER TABLE public.model_run_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own outcomes"
  ON public.model_run_outcomes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.model_run_outcomes IS 'A/B: record which model won (win/loss/timeout/malformed) for task-based routing and fallback';
