-- Add optional GitHub metadata to workspaces (v1 import-only, no push/PRs)
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS github_repo_url TEXT,
  ADD COLUMN IF NOT EXISTS github_default_branch TEXT;

COMMENT ON COLUMN public.workspaces.github_repo_url IS 'GitHub repo URL (e.g. https://github.com/user/repo) for import/re-sync';
COMMENT ON COLUMN public.workspaces.github_default_branch IS 'Branch used for clone (e.g. main)';
