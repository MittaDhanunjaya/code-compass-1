/**
 * GitHub OAuth app credentials: env vars take precedence, then DB (github_oauth_config).
 * Used only server-side; never expose client_secret to the client.
 */

import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";

export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

export async function getGitHubOAuthConfig(): Promise<GitHubOAuthConfig | null> {
  const fromEnv =
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }
      : null;
  if (fromEnv) return fromEnv;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("github_oauth_config")
    .select("client_id, client_secret_encrypted")
    .eq("id", 1)
    .single();

  if (error || !data?.client_id || !data.client_secret_encrypted) return null;
  try {
    const clientSecret = decrypt(data.client_secret_encrypted);
    return { clientId: data.client_id, clientSecret };
  } catch {
    return null;
  }
}

/** Returns client ID only (for display/masking). Env first, then DB. */
export async function getGitHubClientIdOnly(): Promise<string | null> {
  if (process.env.GITHUB_CLIENT_ID) return process.env.GITHUB_CLIENT_ID;
  const supabase = await createClient();
  const { data } = await supabase
    .from("github_oauth_config")
    .select("client_id")
    .eq("id", 1)
    .single();
  return data?.client_id ?? null;
}
