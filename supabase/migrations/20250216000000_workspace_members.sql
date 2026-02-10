-- Workspace roles: owner vs collaborator for future team features
-- Owner = workspace.owner_id; collaborators stored here with role.

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'collaborator' CHECK (role IN ('collaborator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON public.workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON public.workspace_members(user_id);

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

-- Members can read their own membership
CREATE POLICY "Users can read own workspace memberships"
  ON public.workspace_members
  FOR SELECT
  USING (auth.uid() = user_id);

-- Only workspace owner can insert/update/delete members (owner_id on workspaces)
CREATE POLICY "Workspace owners can manage members"
  ON public.workspace_members
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.workspaces w
      WHERE w.id = workspace_id AND w.owner_id = auth.uid()
    )
  );

COMMENT ON TABLE public.workspace_members IS 'Collaborators on a workspace; owner is workspace.owner_id. Used for future: who can toggle Safe Edit, add providers.';
