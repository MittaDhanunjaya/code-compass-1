-- Function to seed default models (callable by API when catalog is empty)
CREATE OR REPLACE FUNCTION public.seed_default_models()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.models (label, provider, model_slug, is_default, is_free, capabilities)
  VALUES
    ('Ollama Qwen (local)', 'ollama', 'qwen:latest', true, true, '{"chat": true, "code": true}'),
    ('OpenRouter Free (auto)', 'openrouter', 'openrouter/free', true, true, '{"chat": true, "code": true}'),
    ('DeepSeek Chat (free)', 'openrouter', 'deepseek/deepseek-chat:free', true, true, '{"chat": true, "code": true}'),
    ('Llama 3.2 3B (free)', 'openrouter', 'meta-llama/llama-3.2-3b-instruct:free', true, true, '{"chat": true, "code": true}'),
    ('Mistral 7B Instruct (free)', 'openrouter', 'mistralai/mistral-7b-instruct:free', true, true, '{"chat": true, "code": true}'),
    ('Google Gemini', 'gemini', 'gemini-2.0-flash', true, true, '{"chat": true, "code": true}'),
    ('Perplexity Sonar', 'perplexity', 'sonar', true, false, '{"chat": true, "code": true}')
  ON CONFLICT (provider, model_slug) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_models() TO authenticated;
