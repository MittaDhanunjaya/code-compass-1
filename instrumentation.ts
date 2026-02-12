/**
 * Next.js instrumentation - runs when the Node.js server starts.
 * Validates environment config at boot; app fails fast if required vars are missing.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { parseEnv } = await import("./lib/config");
    parseEnv();
  }
}
