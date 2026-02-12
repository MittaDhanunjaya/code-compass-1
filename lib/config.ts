/**
 * Environment configuration with Zod validation.
 * Fails fast at boot if required vars are missing.
 * Provider keys and secrets are NEVER included in this config - they are loaded server-side only (DB, etc.).
 */

import { z } from "zod";

const envSchema = z.object({
  // Required
  ENCRYPTION_KEY: z
    .string()
    .min(16, "ENCRYPTION_KEY must be at least 16 characters"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url("NEXT_PUBLIC_SUPABASE_URL must be a valid URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY is required"),

  // Optional - with defaults or optional()
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  CODE_COMPASS_CI_TOKEN: z.string().optional(),
  ADMIN_USER_IDS: z.string().optional(),
  DEV_TEST_TOKEN: z.string().optional(),
  DEV_TEST_USER_ID: z.string().optional(),
  DEV_OPENROUTER_API_KEY: z.string().optional(),
  E2E_BASE_URL: z.string().optional(),
  E2E_USER_EMAIL: z.string().optional(),
  E2E_USER_PASSWORD: z.string().optional(),
  E2E_OPENROUTER_KEY: z.string().optional(),
  E2E_GITHUB_REPO_URL: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
  WORKSPACE_BASE_DIR: z.string().optional(),
  SANDBOX_BASE_DIR: z.string().optional(),
  LMSTUDIO_BASE_URL: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedConfig: EnvConfig | null = null;

/**
 * Parse and validate environment variables. Throws on first failure.
 * Call at app boot (e.g. instrumentation.ts) to fail fast.
 */
export function parseEnv(): EnvConfig {
  if (cachedConfig) return cachedConfig;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.flatten();
    const msg = Object.entries(errors.fieldErrors)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("; ");
    throw new Error(`Environment validation failed: ${msg}`);
  }
  cachedConfig = result.data;
  return cachedConfig;
}

/**
 * Get validated config. Use parseEnv() at boot; this returns cached config.
 */
export function getConfig(): EnvConfig {
  if (!cachedConfig) return parseEnv();
  return cachedConfig;
}
