/**
 * Dev-only auth bypass for scripting Agent APIs (plan, execute, debug-from-log).
 * When NODE_ENV === "development" and X-Dev-Token header matches DEV_TEST_TOKEN,
 * returns an impersonated user so curl/scripts can call APIs without browser cookies.
 *
 * Set in .env.local:
 *   DEV_TEST_TOKEN=<secret>
 *   DEV_TEST_USER_ID=<supabase-user-id>  (e.g. owner of your test workspace)
 *
 * Usage:
 *   curl -H "X-Dev-Token: $DEV_TEST_TOKEN" -H "Content-Type: application/json" \
 *     -d '{"instruction":"...","workspaceId":"..."}' \
 *     http://localhost:3000/api/agent/plan-stream
 */
export type DevBypassUser = { id: string };

export function getDevBypassUser(request: Request): DevBypassUser | null {
  if (process.env.NODE_ENV !== "development") return null;
  const token = process.env.DEV_TEST_TOKEN;
  const userId = process.env.DEV_TEST_USER_ID?.trim();
  const headerToken = request.headers.get("x-dev-token");
  if (headerToken !== token) return null;
  if (!token) return null;
  if (!userId) return null; // DEV_TEST_USER_ID required
  return { id: userId };
}

/** Return a hint when X-Dev-Token was sent but bypass failed (e.g. missing DEV_TEST_USER_ID). */
export function getDevBypassConfigHint(request: Request): string | null {
  const headerToken = request.headers.get("x-dev-token");
  if (!headerToken) return null;
  if (process.env.NODE_ENV !== "development") return null;
  const token = process.env.DEV_TEST_TOKEN;
  const userId = process.env.DEV_TEST_USER_ID?.trim();
  if (headerToken === token && !userId) {
    return "DEV_TEST_USER_ID is empty. Add your Supabase user UUID to .env.local (Authentication → Users in dashboard).";
  }
  return null;
}
