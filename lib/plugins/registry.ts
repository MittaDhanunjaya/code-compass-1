/**
 * Phase 13.2: Plugin registry.
 * Loads and activates plugins. Placeholder for future extensibility.
 */

import { logger } from "@/lib/logger";
import type { Plugin, PluginContext } from "./types";

const plugins: Map<string, Plugin> = new Map();

/**
 * Register a plugin. Call from plugin entry point.
 */
export function registerPlugin(plugin: Plugin): void {
  if (plugins.has(plugin.name)) {
    logger.warn({ event: "plugin_overwrite", pluginName: plugin.name });
  }
  plugins.set(plugin.name, plugin);
}

/**
 * Activate all registered plugins with the given context.
 */
export async function activatePlugins(context: PluginContext): Promise<void> {
  for (const [name, plugin] of plugins) {
    try {
      await plugin.activate(context);
    } catch (e) {
      logger.error({ event: "plugin_activate_failed", pluginName: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * Deactivate all plugins.
 */
export async function deactivatePlugins(): Promise<void> {
  for (const [name, plugin] of plugins) {
    if (plugin.deactivate) {
      try {
        await plugin.deactivate();
      } catch (e) {
        logger.error({ event: "plugin_deactivate_failed", pluginName: name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}

/**
 * Get list of registered plugin names.
 */
export function getPluginNames(): string[] {
  return Array.from(plugins.keys());
}
