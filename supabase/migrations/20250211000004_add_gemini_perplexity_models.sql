-- Add Gemini and Perplexity to the default models catalog so they appear when user has API keys.
INSERT INTO public.models (label, provider, model_slug, is_default, is_free, capabilities)
VALUES
  ('Google Gemini', 'gemini', 'gemini-2.0-flash', true, true, '{"chat": true, "code": true}'),
  ('Perplexity Sonar', 'perplexity', 'sonar', true, false, '{"chat": true, "code": true}')
ON CONFLICT (provider, model_slug) DO NOTHING;
