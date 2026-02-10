/**
 * Per-workspace stack configuration: .code-compass/config.json
 * SERVER-ONLY: uses fs/path. Do not import from client components.
 * For types and constants, use code-compass-config-types.ts.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  CODE_COMPASS_CONFIG_PATH,
  validateCodeCompassConfig,
  parseCodeCompassConfigFromContent,
  type CodeCompassConfig,
} from "./code-compass-config-types";

export { CODE_COMPASS_CONFIG_PATH, validateCodeCompassConfig, parseCodeCompassConfigFromContent };
export type { CodeCompassConfig, CodeCompassServiceConfig, CodeCompassStack } from "./code-compass-config-types";

/**
 * Load and parse .code-compass/config.json from a workspace root (filesystem path).
 * Returns null if file is missing or unreadable.
 */
export async function loadCodeCompassConfig(
  workspaceRoot: string
): Promise<CodeCompassConfig | null> {
  return loadCodeCompassConfigSync(workspaceRoot);
}

/**
 * Synchronous version for use in sandbox stack-commands (sync fs APIs).
 */
export function loadCodeCompassConfigSync(
  workspaceRoot: string
): CodeCompassConfig | null {
  const fullPath = join(workspaceRoot, CODE_COMPASS_CONFIG_PATH);
  if (!existsSync(fullPath)) return null;
  try {
    const raw = readFileSync(fullPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const result = validateCodeCompassConfig(parsed);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}
