-- Phase 4: Charge additional tokens when provider reports actual > reserved.
-- For reconciliation: reserved X, used Y. If Y > X, charge (Y - X).
-- Does not weaken atomic enforcement; used only after provider-confirmed usage.

CREATE OR REPLACE FUNCTION public.charge_additional_tokens(
  p_user_id UUID,
  p_tokens INTEGER,
  p_workspace_id UUID DEFAULT NULL,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS void AS $$
BEGIN
  IF p_tokens <= 0 THEN RETURN; END IF;

  -- Add to user daily usage (no limit check - reconciliation only)
  INSERT INTO public.token_usage_daily (user_id, date, tokens_used, updated_at)
  VALUES (p_user_id, p_date, p_tokens, NOW())
  ON CONFLICT (user_id, date) DO UPDATE
  SET tokens_used = token_usage_daily.tokens_used + p_tokens, updated_at = NOW();

  -- Add to workspace if provided
  IF p_workspace_id IS NOT NULL THEN
    INSERT INTO public.token_usage_workspace_daily (workspace_id, date, tokens_used, updated_at)
    VALUES (p_workspace_id, p_date, p_tokens, NOW())
    ON CONFLICT (workspace_id, date) DO UPDATE
    SET tokens_used = token_usage_workspace_daily.tokens_used + p_tokens, updated_at = NOW();
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.charge_additional_tokens IS 'Charge additional tokens when provider-reported usage exceeds reserved. Used for reconciliation only.';
