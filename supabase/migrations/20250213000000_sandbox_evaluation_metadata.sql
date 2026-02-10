-- Step 2 evaluation: store error log, outcome, and rollback for debug-from-log (and future analysis)
ALTER TABLE public.sandbox_runs
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS user_rolled_back BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.sandbox_runs.metadata IS 'Optional: error_log, error_type, model_used, proposed_edit_paths for debug-from-log runs';
COMMENT ON COLUMN public.sandbox_runs.user_rolled_back IS 'Set when user rejects or reverts applied changes';

CREATE INDEX IF NOT EXISTS idx_sandbox_runs_source ON public.sandbox_runs(source);
CREATE INDEX IF NOT EXISTS idx_sandbox_runs_checks_passed ON public.sandbox_runs(sandbox_checks_passed);
