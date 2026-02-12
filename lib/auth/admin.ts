/**
 * Admin role check for debug and privileged routes.
 * Admin users are defined via ADMIN_USER_IDS env (comma-separated Supabase user IDs).
 */

function getAdminUserIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((id) => id.trim()).filter(Boolean));
}

/**
 * Check if the given user ID is an admin.
 */
export function isAdmin(userId: string): boolean {
  if (!userId) return false;
  return getAdminUserIds().has(userId);
}
