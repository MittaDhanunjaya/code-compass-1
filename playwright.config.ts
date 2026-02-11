import { defineConfig, devices } from "@playwright/test";
import * as path from "path";

// Load .env.local for E2E_USER_EMAIL, E2E_USER_PASSWORD, etc.
require("dotenv").config({ path: path.join(process.cwd(), ".env.local") });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3001",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Assume app is already running (npm run dev). Set CI=1 to auto-start.
  webServer: process.env.CI
    ? { command: "npm run dev", url: "http://localhost:3001", reuseExistingServer: true, timeout: 60_000 }
    : undefined,
});
