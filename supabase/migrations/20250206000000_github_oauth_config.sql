-- GitHub OAuth app credentials configurable from Settings UI (optional; env vars still take precedence)
-- Single row; client_secret stored encrypted (same ENCRYPTION_KEY as provider_keys).
CREATE TABLE IF NOT EXISTS public.github_oauth_config (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id text,
  client_secret_encrypted text,
  updated_at timestamptZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.github_oauth_config (id, updated_at) VALUES (1, NOW())
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.github_oauth_config IS 'App-level GitHub OAuth client ID/secret (from Settings UI). Env vars take precedence.';

ALTER TABLE public.github_oauth_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read and update github_oauth_config"
  ON public.github_oauth_config
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
