/**
 * Active workspace per user: persisted so chat, agent, composer, debug-from-log, and Git
 * can resolve workspace when the client does not send an explicit workspaceId.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export async function getActiveWorkspaceIdForUser(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("user_workspace_state")
    .select("active_workspace_id")
    .eq("user_id", userId)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  const id = data?.active_workspace_id;
  return typeof id === "string" ? id : null;
}

/**
 * Set the user's active workspace. Enforces that the workspace belongs to the user.
 * Pass null to clear the active workspace.
 */
export async function setActiveWorkspaceIdForUser(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string | null
): Promise<void> {
  if (workspaceId !== null && workspaceId.trim() !== "") {
    const { data: workspace, error: fetchError } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId.trim())
      .eq("owner_id", userId)
      .single();
    if (fetchError || !workspace) {
      throw new Error("Workspace not found or access denied");
    }
  }

  const { error } = await supabase
    .from("user_workspace_state")
    .upsert(
      {
        user_id: userId,
        active_workspace_id: workspaceId?.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
  if (error) throw error;
}

/**
 * Resolve workspace ID: explicit from client first, then active for user, else null.
 * Use this in routes that accept optional workspaceId in body/params.
 */
export async function resolveWorkspaceId(
  supabase: SupabaseClient,
  userId: string,
  explicitWorkspaceId: string | null | undefined
): Promise<string | null> {
  const trimmed = typeof explicitWorkspaceId === "string" ? explicitWorkspaceId.trim() : "";
  if (trimmed) return trimmed;
  return getActiveWorkspaceIdForUser(supabase, userId);
}
