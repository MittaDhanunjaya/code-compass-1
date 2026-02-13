-- Background refund queue for failed refundBudget calls.
-- Retries asynchronously with exponential backoff. Does not block request completion.

CREATE TABLE IF NOT EXISTS public.refund_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tokens INTEGER NOT NULL,
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_queue_status_next_retry ON public.refund_queue(status, next_retry_at) WHERE status = 'pending';

ALTER TABLE public.refund_queue ENABLE ROW LEVEL SECURITY;

-- Users can insert their own refund requests (when direct refund fails).
CREATE POLICY "Users can insert own refund requests"
  ON public.refund_queue FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Service role reads/updates for queue processor (no SELECT/UPDATE for users).
COMMENT ON TABLE public.refund_queue IS 'Background queue for failed refunds. Processed by cron with exponential backoff.';
