-- Multi-model support: models catalog, user_models (API keys per model), model_groups, model_group_members

-- Catalog of known models (built-in + user-addable)
CREATE TABLE IF NOT EXISTS public.models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_slug TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_free BOOLEAN NOT NULL DEFAULT false,
  capabilities JSONB NOT NULL DEFAULT '{"chat": true, "code": true}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, model_slug)
);

CREATE INDEX IF NOT EXISTS idx_models_provider ON public.models(provider);
CREATE INDEX IF NOT EXISTS idx_models_is_default ON public.models(is_default) WHERE is_default = true;

-- User's added models (API key + optional alias)
CREATE TABLE IF NOT EXISTS public.user_models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  api_key_encrypted TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  alias_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_user_models_user_id ON public.user_models(user_id);
CREATE INDEX IF NOT EXISTS idx_user_models_model_id ON public.user_models(model_id);

-- Model groups (e.g. planner + coder + reviewer)
CREATE TABLE IF NOT EXISTS public.model_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_groups_user_id ON public.model_groups(user_id);

-- Which models belong to a group and their role/priority
CREATE TABLE IF NOT EXISTS public.model_group_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID NOT NULL REFERENCES public.model_groups(id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES public.models(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'coder',
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_model_group_members_group_id ON public.model_group_members(group_id);

-- RLS
ALTER TABLE public.models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_group_members ENABLE ROW LEVEL SECURITY;

-- models: read-only for authenticated users
CREATE POLICY "Anyone authenticated can read models"
  ON public.models FOR SELECT
  TO authenticated
  USING (true);

-- user_models: own rows only
CREATE POLICY "Users can manage own user_models"
  ON public.user_models FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- model_groups: own rows only
CREATE POLICY "Users can manage own model_groups"
  ON public.model_groups FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- model_group_members: manage if user owns the group
CREATE POLICY "Users can manage members of own groups"
  ON public.model_group_members FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.model_groups g
      WHERE g.id = model_group_members.group_id AND g.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.model_groups g
      WHERE g.id = model_group_members.group_id AND g.user_id = auth.uid()
    )
  );
