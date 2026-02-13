-- Budget refund: subtract tokens (capped at 0). Does not weaken atomic enforcement.
-- Idempotent reservations: track request_id so retries do not double-charge.

-- Idempotency table: one row per reserved request.
CREATE TABLE IF NOT EXISTS public.budget_reservation_ids (
  request_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tokens_reserved INTEGER NOT NULL,
  date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_reservation_ids_user_date ON public.budget_reservation_ids(user_id, date);

ALTER TABLE public.budget_reservation_ids ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own budget reservations"
  ON public.budget_reservation_ids FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own budget reservations"
  ON public.budget_reservation_ids FOR INSERT
  WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.budget_reservation_ids IS 'Idempotent budget reservations keyed by requestId. Prevents double-charge on retries.';

-- Refund: subtract tokens from user and workspace. Caps at 0.
CREATE OR REPLACE FUNCTION public.refund_tokens(
  p_user_id UUID,
  p_tokens INTEGER,
  p_workspace_id UUID DEFAULT NULL,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS void AS $$
BEGIN
  IF p_tokens <= 0 THEN RETURN; END IF;

  UPDATE public.token_usage_daily
  SET tokens_used = GREATEST(0, tokens_used - p_tokens), updated_at = NOW()
  WHERE user_id = p_user_id AND date = p_date;

  IF p_workspace_id IS NOT NULL THEN
    UPDATE public.token_usage_workspace_daily
    SET tokens_used = GREATEST(0, tokens_used - p_tokens), updated_at = NOW()
    WHERE workspace_id = p_workspace_id AND date = p_date;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refund_tokens IS 'Refund unused reserved tokens. Caps at 0.';

-- Idempotent reserve: only charge on first request for a given request_id.
-- Retries with same request_id return success without double-charging.
CREATE OR REPLACE FUNCTION public.reserve_budget_idempotent(
  p_request_id TEXT,
  p_user_id UUID,
  p_tokens INTEGER,
  p_user_limit INTEGER,
  p_workspace_id UUID DEFAULT NULL,
  p_workspace_limit INTEGER DEFAULT NULL,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS void AS $$
DECLARE
  v_row_count INTEGER;
BEGIN
  IF p_request_id IS NULL OR p_request_id = '' THEN
    RAISE EXCEPTION 'request_id is required for idempotent reservation';
  END IF;

  -- Atomic: only first insert succeeds. Retries get conflict.
  INSERT INTO public.budget_reservation_ids (request_id, user_id, tokens_reserved, date)
  VALUES (p_request_id, p_user_id, p_tokens, p_date)
  ON CONFLICT (request_id) DO NOTHING;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  -- Only charge when we are the first reservation (insert succeeded).
  IF v_row_count > 0 THEN
    PERFORM public.enforce_and_record_tokens(
      p_user_id, p_tokens, p_user_limit, p_workspace_id, p_workspace_limit, p_date
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.reserve_budget_idempotent IS 'Idempotent budget reservation. Retries with same request_id do not double-charge.';
