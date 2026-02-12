/**
 * Next.js instrumentation - runs when the Node.js server starts.
 * Validates environment config at boot; activates plugins (Phase 13.2.2).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { parseEnv } = await import("./lib/config");
    parseEnv();

    // Phase 13.2.2: Activate plugins with context (registerProvider, registerAgentHook)
    const { activatePlugins } = await import("./lib/plugins/registry");
    const { getCustomProviders } = await import("./lib/plugins/custom-providers");
    const { APP_VERSION } = await import("./lib/version");
    await activatePlugins({
      appVersion: APP_VERSION,
      registerProvider: (id: string, config: unknown) => {
        getCustomProviders().set(id, config);
      },
      registerAgentHook: () => {
        // Placeholder: agent hooks would be stored and invoked by agent pipeline
      },
    });
  }
}
