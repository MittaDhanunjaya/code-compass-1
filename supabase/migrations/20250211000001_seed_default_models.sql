-- Seed default models: Ollama (local), OpenRouter free/cheap

INSERT INTO public.models (id, label, provider, model_slug, is_default, is_free, capabilities)
VALUES
  -- Ollama local
  (uuid_generate_v4(), 'Ollama Qwen (local)', 'ollama', 'qwen:latest', true, true, '{"chat": true, "code": true}'),
  -- OpenRouter free
  (uuid_generate_v4(), 'OpenRouter Free (auto)', 'openrouter', 'openrouter/free', true, true, '{"chat": true, "code": true}'),
  (uuid_generate_v4(), 'DeepSeek Chat (free)', 'openrouter', 'deepseek/deepseek-chat:free', true, true, '{"chat": true, "code": true}'),
  (uuid_generate_v4(), 'Llama 3.2 3B (free)', 'openrouter', 'meta-llama/llama-3.2-3b-instruct:free', true, true, '{"chat": true, "code": true}'),
  (uuid_generate_v4(), 'Mistral 7B Instruct (free)', 'openrouter', 'mistralai/mistral-7b-instruct:free', true, true, '{"chat": true, "code": true}')
ON CONFLICT (provider, model_slug) DO NOTHING;
