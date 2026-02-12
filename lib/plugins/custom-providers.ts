/**
 * Phase 13.2.2: Registry for custom providers registered by plugins.
 * Wired via PluginContext.registerProvider when plugins activate.
 */

const customProviders = new Map<string, unknown>();

export function getCustomProviders(): Map<string, unknown> {
  return customProviders;
}
