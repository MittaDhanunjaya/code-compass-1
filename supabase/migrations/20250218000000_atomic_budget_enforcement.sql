-- Atomic budget enforcement: check + increment in one transaction.
-- Prevents race conditions where concurrent requests exceed daily limits.

CREATE OR REPLACE FUNCTION public.enforce_and_record_tokens(
  p_user_id UUID,
  p_tokens INTEGER,
  p_user_limit INTEGER,
  p_workspace_id UUID DEFAULT NULL,
  p_workspace_limit INTEGER DEFAULT NULL,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS void AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  -- Ensure row exists, then atomic update with check. Single statement prevents race.
  INSERT INTO public.token_usage_daily (user_id, date, tokens_used, updated_at)
  VALUES (p_user_id, p_date, 0, NOW())
  ON CONFLICT (user_id, date) DO NOTHING;

  UPDATE public.token_usage_daily
  SET tokens_used = tokens_used + p_tokens, updated_at = NOW()
  WHERE user_id = p_user_id AND date = p_date AND (tokens_used + p_tokens) <= p_user_limit;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'BUDGET_EXCEEDED:user:Daily token budget exceeded. Try again tomorrow.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Workspace: same pattern
  IF p_workspace_id IS NOT NULL AND p_workspace_limit IS NOT NULL THEN
    INSERT INTO public.token_usage_workspace_daily (workspace_id, date, tokens_used, updated_at)
    VALUES (p_workspace_id, p_date, 0, NOW())
    ON CONFLICT (workspace_id, date) DO NOTHING;

    UPDATE public.token_usage_workspace_daily
    SET tokens_used = tokens_used + p_tokens, updated_at = NOW()
    WHERE workspace_id = p_workspace_id AND date = p_date AND (tokens_used + p_tokens) <= p_workspace_limit;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'BUDGET_EXCEEDED:workspace:Workspace daily token limit exceeded. Try again tomorrow.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.enforce_and_record_tokens IS 'Atomic check + increment for token budget. Fails if increment would exceed limits.';
