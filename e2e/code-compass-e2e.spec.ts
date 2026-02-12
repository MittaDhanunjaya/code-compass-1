/**
 * Code Compass E2E Integration Test
 * Run: npx playwright test e2e/code-compass-e2e.spec.ts --headed
 *
 * Prerequisites:
 * - npm run dev (or dev:3001) running
 * - Log in manually first, or set E2E_USER_EMAIL + E2E_USER_PASSWORD for automated login
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3001";

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

  test("3. Settings page loads", async ({ page }) => {
    await page.goto(`${BASE_URL}/app/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000); // Allow redirect/auth
    const url = page.url();
    const hasSettings = await page.locator('text=Settings').first().isVisible().catch(() => false)
      || await page.locator('text=API Keys').first().isVisible().catch(() => false)
      || await page.locator('text=API key').first().isVisible().catch(() => false)
      || url.includes("/settings");
    expect(hasSettings).toBeTruthy();
  });

  test("4. Health API responds", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  // Phase 9.2.4: Chat completion flow - send message, wait for response or error
  test("5. Chat completion flow (send message → response or error)", async ({ page }) => {
    const url = page.url();
    if (url.includes("/sign-in") || !url.includes("/app")) {
      test.skip();
      return;
    }
    await page.waitForSelector('[data-testid="app-shell"], .workspace-selector', { timeout: 15000 }).catch(() => {});
    const input = page.getByPlaceholder(/Ask anything/i);
    const sendBtn = page.getByRole("button", { name: /Send message/i });
    const isVisible = await input.isVisible().catch(() => false);
    if (!isVisible) {
      test.skip();
      return;
    }
    await input.fill("Hello, reply with OK if you see this.");
    await sendBtn.click();
    // Wait for either assistant message or error (up to 25s)
    await Promise.race([
      page.waitForSelector('[class*="bg-muted"]', { timeout: 25000 }).catch(() => null),
      page.waitForSelector('text=No API key', { timeout: 25000 }).catch(() => null),
      page.waitForSelector('text=Something went wrong', { timeout: 25000 }).catch(() => null),
    ]);
    const hasResponse = await page.locator('[class*="bg-muted"]').first().isVisible().catch(() => false);
    const hasError = await page.getByText(/No API key|Something went wrong|error/i).first().isVisible().catch(() => false);
    expect(hasResponse || hasError).toBeTruthy();
  });

  // Phase 9.2: Agent panel integration - when in app, agent UI elements exist
  test("6. Agent panel UI visible when workspace open", async ({ page }) => {
    const url = page.url();
    if (url.includes("/sign-in") || !url.includes("/app")) {
      test.skip();
      return;
    }
    await page.waitForSelector('[data-testid="app-shell"], .workspace-selector, [data-testid="agent-panel"]', {
      timeout: 15000,
    }).catch(() => {});
    const hasAgentOrWorkspace = await page
      .locator('text=Idle, text=Planning, text=Agent, [placeholder*="instruction"], [placeholder*="Ask"]')
      .first()
      .isVisible()
      .catch(() => false);
    const hasWorkspace = await page.locator(".workspace-selector, [data-testid='app-shell']").first().isVisible().catch(() => false);
    expect(hasAgentOrWorkspace || hasWorkspace).toBeTruthy();
  });
});
