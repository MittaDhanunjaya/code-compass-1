/**
 * Centralized auth for API routes.
 * Use requireAuth(request) for routes that support dev bypass (agent, execute-stream, debug-from-log).
 * Use requireAuth() for all other protected routes.
 */

import { createClient } from "@/lib/supabase/server";
import { getDevBypassUser, getDevBypassConfigHint } from "@/lib/auth-dev-bypass";

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
 * Usage: return withAuthResponse(await requireAuth(request));
 */
export function withAuthResponse(error: unknown): Response | null {
  if (error instanceof AuthError) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: error.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}
