/**
 * Phase 13.2.1: Plugin API for Code Compass extensibility.
 * Defines the contract for plugins (custom agents, providers, etc.).
 * Full implementation deferred; this establishes the interface.
 */

/**
 * Context passed to plugins when activated.
 */
export type PluginContext = {
  /** App version */
  appVersion: string;
  /** User ID if authenticated */
  userId?: string;
  /** Workspace ID if in workspace context */
  workspaceId?: string;
  /** Register a custom provider (future) */
  registerProvider?: (id: string, config: unknown) => void;
  /** Register custom agent hooks (future) */
  registerAgentHook?: (hook: AgentHook) => void;
};

/**
 * Hook for custom agent behavior (e.g. pre-plan, post-execute).
 */
export type AgentHook = {
  name: string;
  beforePlan?: (instruction: string) => string | Promise<string>;
  afterExecute?: (result: unknown) => void | Promise<void>;
};

/**
 * Plugin interface. Implement this to create a Code Compass plugin.
 */
export interface Plugin {
  /** Unique plugin identifier */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description?: string;
  /**
   * Called when the plugin is activated.
   * @param context - Runtime context for registration
   */
  activate(context: PluginContext): void | Promise<void>;
  /**
   * Called when the plugin is deactivated (e.g. app shutdown).
   */
  deactivate?(): void | Promise<void>;
}
