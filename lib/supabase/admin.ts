/**
 * Supabase admin client for background jobs (e.g. refund queue processor).
 * Uses SUPABASE_SERVICE_ROLE_KEY. Bypasses RLS.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required for admin operations. Set in .env.local for refund queue processing."
    );
  }
  adminClient = createClient(url, key, { auth: { persistSession: false } });
  return adminClient;
}
