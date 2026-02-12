/**
 * Centralized auth for API routes.
 * Phase 7.1.2: Returns user-friendly "Please re-authenticate" for 401.
 */

import { createClient } from "@/lib/supabase/server";
import { getDevBypassUser, getDevBypassConfigHint } from "@/lib/auth-dev-bypass";
import { getUserFriendlyMessage, classifyError } from "@/lib/errors";

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export type AuthResult = {
  user: { id: string };
  supabase: Awaited<ReturnType<typeof createClient>>;
};

/**
 * Require authenticated user. Throws AuthError(401) if unauthenticated.
 * When request is provided, supports dev bypass (X-Dev-Token) in development.
 * When dev bypass fails with config hint (e.g. missing DEV_TEST_USER_ID), throws AuthError(400) with hint.
 */
export async function requireAuth(request?: Request): Promise<AuthResult> {
  const supabase = await createClient();

  if (request) {
    const devUser = getDevBypassUser(request);
    if (devUser) {
      return { user: devUser, supabase };
    }

    const hint = getDevBypassConfigHint(request);
    if (hint) {
      throw new AuthError(400, hint);
    }
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new AuthError(401, "Unauthorized");
  }

  return { user: { id: user.id }, supabase };
}

/**
 * Wrap a route handler to catch AuthError and return the correct HTTP response.
 * Phase 7.1.2: Uses user-friendly message for 401.
 */
export function withAuthResponse(error: unknown): Response | null {
  if (error instanceof AuthError) {
    const category = classifyError(error.statusCode);
    const message =
      category === "auth"
        ? getUserFriendlyMessage("auth")
        : error.message;
    return new Response(JSON.stringify({ error: message }), {
      status: error.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

/**
 * Require authenticated user with workspace access (owner or member).
 * Returns { user, supabase } or throws AuthError(401) / AuthError(403).
 */
export async function requireWorkspaceAccess(
  request: Request | undefined,
  workspaceId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<AuthResult> {
  const auth = await requireAuth(request);
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .single();

  if (!workspace) {
    throw new AuthError(404, "Workspace not found");
  }

  const { data: member } = await supabase
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const { data: ws } = await supabase
    .from("workspaces")
    .select("owner_id")
    .eq("id", workspaceId)
    .single();

  const isOwner = (ws as { owner_id?: string } | null)?.owner_id === auth.user.id;
  const isMember = !!member;

  if (!isOwner && !isMember) {
    throw new AuthError(403, "Forbidden");
  }

  return auth;
}
