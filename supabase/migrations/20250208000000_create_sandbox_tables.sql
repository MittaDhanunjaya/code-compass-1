-- AIForge: Sandbox tables for sandbox-first execution pipeline
-- Sandboxes are temporary copies of workspace files used for testing edits before applying to main workspace

-- sandbox_runs: tracks each sandbox run (one per agent/composer/debug-from-log execution)
CREATE TABLE IF NOT EXISTS public.sandbox_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT, -- "agent" | "composer" | "debug-from-log"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ, -- when sandbox was promoted to workspace (null if not promoted)
  sandbox_checks_passed BOOLEAN DEFAULT false -- whether lint/tests passed
);

-- sandbox_files: files in a sandbox (mirrors workspace_files structure)
CREATE TABLE IF NOT EXISTS public.sandbox_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sandbox_run_id UUID NOT NULL REFERENCES public.sandbox_runs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(sandbox_run_id, path)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_workspace_id ON public.sandbox_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_user_id ON public.sandbox_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_created_at ON public.sandbox_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sandbox_files_sandbox_run_id ON public.sandbox_files(sandbox_run_id);
CREATE INDEX IF NOT EXISTS idx_sandbox_files_path ON public.sandbox_files(sandbox_run_id, path);

-- RLS: enable Row Level Security
ALTER TABLE public.sandbox_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sandbox_files ENABLE ROW LEVEL SECURITY;

-- sandbox_runs: users can only access runs in workspaces they own
CREATE POLICY "Users can manage sandbox runs in own workspaces"
  ON public.sandbox_runs
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    ) AND user_id = auth.uid()
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    ) AND user_id = auth.uid()
  );

-- sandbox_files: users can only access files in sandbox runs they own
CREATE POLICY "Users can manage files in own sandbox runs"
  ON public.sandbox_files
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.sandbox_runs sr
      JOIN public.workspaces w ON w.id = sr.workspace_id
      WHERE sr.id = sandbox_run_id AND w.owner_id = auth.uid() AND sr.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sandbox_runs sr
      JOIN public.workspaces w ON w.id = sr.workspace_id
      WHERE sr.id = sandbox_run_id AND w.owner_id = auth.uid() AND sr.user_id = auth.uid()
    )
  );
