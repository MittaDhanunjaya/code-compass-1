-- v2 GitHub: user GitHub link (OAuth token + profile), OAuth state, workspace sync fields

-- user_github: one row per user when GitHub is connected. Token never exposed to frontend.
CREATE TABLE IF NOT EXISTS public.user_github (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  github_user_id TEXT NOT NULL,
  github_username TEXT NOT NULL,
  github_avatar_url TEXT,
  github_access_token_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.user_github IS 'GitHub OAuth link: profile + encrypted access token (server-only)';

ALTER TABLE public.user_github ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own user_github"
  ON public.user_github
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- github_oauth_state: short-lived state for "Connect GitHub" flow (state -> user_id)
CREATE TABLE IF NOT EXISTS public.github_oauth_state (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional: index for cleanup of expired state (e.g. delete where created_at < now() - interval '10 min')
CREATE INDEX IF NOT EXISTS idx_github_oauth_state_created_at ON public.github_oauth_state(created_at);

ALTER TABLE public.github_oauth_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own github_oauth_state"
  ON public.github_oauth_state
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Workspace GitHub sync fields (keep existing github_repo_url, github_default_branch)
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS github_owner TEXT,
  ADD COLUMN IF NOT EXISTS github_repo TEXT,
  ADD COLUMN IF NOT EXISTS github_is_private BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS github_current_branch TEXT;

COMMENT ON COLUMN public.workspaces.github_owner IS 'GitHub owner (user or org) parsed from repo URL';
COMMENT ON COLUMN public.workspaces.github_repo IS 'GitHub repo name parsed from URL';
COMMENT ON COLUMN public.workspaces.github_is_private IS 'Whether the linked repo is private (requires OAuth)';
COMMENT ON COLUMN public.workspaces.github_current_branch IS 'Current branch for sync (commit/push target)';
