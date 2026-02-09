-- User's preferred default model group for Agent (optional). When null, app uses computed best default.
CREATE TABLE IF NOT EXISTS public.user_agent_preferences (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  default_model_group_id UUID REFERENCES public.model_groups(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_agent_preferences_user_id ON public.user_agent_preferences(user_id);

ALTER TABLE public.user_agent_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own agent preferences"
  ON public.user_agent_preferences
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.user_agent_preferences IS 'Stores user preference for default model group in Agent; null = use app-computed best default.';
