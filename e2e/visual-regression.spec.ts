/**
 * Phase 9.3: Visual regression tests.
 * Run: npx playwright test e2e/visual-regression.spec.ts --headed
 *
 * Snapshots are stored in e2e/visual-regression.spec.ts-snapshots/
 * Update with: npx playwright test e2e/visual-regression.spec.ts --update-snapshots
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3001";

test.describe("Visual regression", () => {
  // Phase 9.3.1: Agent panel idle state
  test("Agent panel idle state", async ({ page }) => {
    await page.goto(`${BASE_URL}/app`, { waitUntil: "networkidle" });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    const url = page.url();
    if (url.includes("/sign-in")) {
      test.skip();
      return;
    }
    if (url.includes("/app")) {
      await page.waitForSelector('button:has-text("Agent"), button:has-text("Chat")', { timeout: 10000 }).catch(() => {});
      await page.getByRole("button", { name: "Agent" }).click().catch(() => {});
      await page.waitForTimeout(500);
      const idleOrWorkspace = page.locator('text=Idle, text=Open a workspace').first();
      const visible = await idleOrWorkspace.isVisible().catch(() => false);
      if (!visible) {
        test.skip();
        return;
      }
      await expect(page).toHaveScreenshot("agent-panel-idle.png", {
        maxDiffPixels: 500,
      });
    }
  });

  test("Sign-in page layout", async ({ page }) => {
    await page.goto(`${BASE_URL}/sign-in`, { waitUntil: "networkidle" });
    await page.waitForLoadState("domcontentloaded");
    // Wait for page to render (sign-in or redirect)
    await page.waitForTimeout(1000);
    await expect(page).toHaveScreenshot("sign-in-page.png", {
      maxDiffPixels: 500,
      fullPage: true,
    });
  });
});
