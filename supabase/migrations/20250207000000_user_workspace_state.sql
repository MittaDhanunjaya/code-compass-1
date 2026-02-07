-- Persist the user's active workspace (single selection across chat, agent, Git, debug-from-log)
CREATE TABLE IF NOT EXISTS public.user_workspace_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active_workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_workspace_state_user_id ON public.user_workspace_state(user_id);

ALTER TABLE public.user_workspace_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own workspace state"
  ON public.user_workspace_state
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.user_workspace_state IS 'Stores the single active workspace per user for chat, agent, Git, and debug-from-log';
