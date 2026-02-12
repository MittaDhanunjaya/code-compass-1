/**
 * App version for CI and deployment checks.
 */
import pkg from "../package.json";

export const APP_VERSION = (pkg as { version?: string }).version ?? "0.0.0";
export const APP_NAME = (pkg as { name?: string }).name ?? "Code Compass";
