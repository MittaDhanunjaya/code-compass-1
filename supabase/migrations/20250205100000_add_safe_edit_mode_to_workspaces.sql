-- Add safe_edit_mode to workspaces (default true: limits large/risky changes, can block push when tests fail)
ALTER TABLE public.workspaces
ADD COLUMN IF NOT EXISTS safe_edit_mode BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.workspaces.safe_edit_mode IS 'When true, limits large or risky AI changes and can block commit & push when tests are failing.';
