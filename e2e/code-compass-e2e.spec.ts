/**
 * Code Compass E2E Integration Test
 * Run: npx playwright test e2e/code-compass-e2e.spec.ts --headed
 *
 * Prerequisites:
 * - npm run dev (or dev:3001) running
 * - Log in manually first, or set E2E_USER_EMAIL + E2E_USER_PASSWORD for automated login
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3000"; // Or 3001 if using npm run dev:3001

test.describe("Code Compass E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
  });

  test("1. App loads and shows sign-in or app", async ({ page }) => {
    await page.waitForLoadState("domcontentloaded");
    const url = page.url();
    const hasSignIn = await page.getByRole("button", { name: /Sign in/i }).isVisible().catch(() => false)
      || await page.locator('text=Sign in').isVisible().catch(() => false);
    const hasApp = url.includes("/app");
    const hasSignInPage = url.includes("/sign-in");
    expect(hasSignIn || hasApp || hasSignInPage).toBeTruthy();
  });

  test("2. If signed in, workspace list or app shell is visible", async ({ page }) => {
    const url = page.url();
    if (url.includes("/sign-in")) {
      test.skip();
      return;
    }
    if (url.includes("/app")) {
      await page.waitForSelector('[data-testid="app-shell"], .workspace-selector, button', { timeout: 10000 }).catch(() => {});
      const hasWorkspaceUI = await page.locator('.workspace-selector, [data-testid="app-shell"], button').first().isVisible().catch(() => false);
      expect(hasWorkspaceUI).toBeTruthy();
    }
  });

  test("3. Settings page loads or redirects to sign-in", async ({ page }) => {
    await page.goto(`${BASE_URL}/app/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); // Allow redirect/auth
    const url = page.url();
    const hasSettings = await page.locator('text=Settings').first().isVisible().catch(() => false)
      || await page.locator('text=API Keys').first().isVisible().catch(() => false)
      || await page.locator('text=API key').first().isVisible().catch(() => false)
      || url.includes("/settings");
    const redirectedToSignIn = url.includes("/sign-in");
    expect(hasSettings || redirectedToSignIn).toBeTruthy();
  });

  test("4. Health API responds", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe("ok");
  });
});
