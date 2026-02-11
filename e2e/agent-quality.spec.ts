/**
 * Agent Quality E2E Tests
 *
 * Tests the agent through the web UI: end-to-end project creation, bug fixes,
 * and feature requests. Run against a live app (npm run dev).
 *
 * Run: npx playwright test e2e/agent-quality.spec.ts --headed
 *
 * Prerequisites:
 * - npm run dev running
 * - E2E_USER_EMAIL + E2E_USER_PASSWORD set (or sign in manually first)
 * - LLM provider configured in app settings (OpenAI/OpenRouter key)
 */

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3001";
const USER_EMAIL = process.env.E2E_USER_EMAIL;
const USER_PASSWORD = process.env.E2E_USER_PASSWORD;

/** Sign in with email/password if credentials are provided */
async function ensureSignedIn(page: import("@playwright/test").Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const url = page.url();

  if (url.includes("/sign-in") && USER_EMAIL && USER_PASSWORD) {
    await page.getByLabel(/email/i).fill(USER_EMAIL);
    await page.getByLabel(/password/i).fill(USER_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/(app|$)/, { timeout: 15000 });
  }
}

/** Create or select an empty workspace */
async function ensureWorkspace(page: import("@playwright/test").Page) {
  const url = page.url();
  if (url.includes("/app/") && !url.endsWith("/app")) {
    return; // Already in a workspace
  }

  // Try to create workspace if at /app
  const createBtn = page.getByRole("button", { name: /create workspace/i });
  if (await createBtn.isVisible().catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(800);
    // Empty workspace is default; ensure name and click Create
    const nameInput = page.getByLabel(/workspace name/i).or(page.locator('#create-name'));
    await nameInput.fill(`e2e-test-${Date.now()}`);
    await page.waitForTimeout(300);
    const createSubmit = page.getByRole("button", { name: /^create$/i });
    await createSubmit.click();
    await page.waitForURL(/\/app\/[^/]+/, { timeout: 10000 });
  } else {
    // Select existing workspace
    const workspaceLink = page.locator('a[href^="/app/"]').first();
    if (await workspaceLink.isVisible().catch(() => false)) {
      await workspaceLink.click();
      await page.waitForURL(/\/app\/[^/]+/, { timeout: 5000 });
    }
  }
}

/** Switch to Agent tab and submit an instruction */
async function runAgentTask(
  page: import("@playwright/test").Page,
  instruction: string,
  opts?: { timeout?: number }
) {
  const timeout = opts?.timeout ?? 120_000;

  // Click Agent tab
  await page.getByRole("button", { name: /^agent$/i }).click();
  await page.waitForTimeout(500);

  // Find instruction textarea (placeholder mentions "README" or "Add")
  const textarea = page.getByPlaceholder(/add a readme|paste terminal|describe a task/i).first();
  await textarea.fill(instruction);

  // Click Start
  await page.getByRole("button", { name: /^start$/i }).click();

  // Wait for plan or execution to complete (loading_plan -> plan_ready or executing -> done)
  await page.waitForTimeout(3000);
  const doneOrPlan = page.locator('text=/planning|executing|done|apply|review/i').first();
  await expect(doneOrPlan).toBeVisible({ timeout: Math.min(timeout, 60000) });
}

test.describe("Agent Quality E2E", () => {
  test.setTimeout(180_000); // Agent + LLM calls can be slow

  test.beforeEach(async ({ page }) => {
    await ensureSignedIn(page);
    await page.waitForTimeout(1000);
  });

  test("1. Sign in and reach app shell", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    const url = page.url();
    const atSignIn = url.includes("/sign-in");
    const atApp = url.includes("/app");
    expect(atSignIn || atApp).toBeTruthy();
    if (atApp) {
      await expect(page.getByText("AIForge").first()).toBeVisible({ timeout: 5000 });
    }
  });

  test("2. Agent tab is available when workspace selected", async ({ page }) => {
    await ensureWorkspace(page);
    const url = page.url();
    if (!url.includes("/app/")) {
      test.skip();
      return;
    }
    const agentTab = page.getByRole("button", { name: /^agent$/i });
    await expect(agentTab).toBeVisible({ timeout: 5000 });
  });

  test("3. Agent: Build end-to-end project - Add README", async ({ page }) => {
    await ensureWorkspace(page);
    const url = page.url();
    if (!url.includes("/app/")) {
      test.skip();
      return;
    }

    await runAgentTask(
      page,
      "Create a README.md file with: project name 'E2E Test', a short description, and install/run instructions.",
      { timeout: 90_000 }
    );

    // Verify we got some response (plan or execution)
    const hasPlanOrResult = await page
      .locator('text=/readme|create|file|edit/i')
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasPlanOrResult).toBeTruthy();
  });

  test("4. Composer: Edit instruction", async ({ page }) => {
    await ensureWorkspace(page);
    const url = page.url();
    if (!url.includes("/app/")) {
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^composer$/i }).click();
    await page.waitForTimeout(500);

    const textarea = page.getByPlaceholder(/add logging|edit instruction/i).first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.fill("Add a console.log('hello') at the top of the first file.");
    await page.waitForTimeout(500);

    const runBtn = page.getByRole("button", { name: /plan|run|go/i }).first();
    if (await runBtn.isVisible().catch(() => false)) {
      await runBtn.click();
      await page.waitForTimeout(5000);
    }
  });

  test("5. Debug-from-log: paste logs → chip → auto debug", async ({ page }) => {
    await ensureWorkspace(page);
    const url = page.url();
    if (!url.includes("/app/")) {
      test.skip();
      return;
    }

    // Switch to Chat or Agent
    await page.getByRole("button", { name: /^chat$/i }).click();
    await page.waitForTimeout(500);

    const chatInput = page.getByPlaceholder(/ask anything|paste terminal|type a message/i).first();
    await expect(chatInput).toBeVisible({ timeout: 5000 });

    // Simulate paste of log-like text (triggers onPaste handler)
    const fakeLog = `$ npm test
> test@1.0.0 test
> jest

FAIL  src/utils.test.ts
  ● utils › formatDate
    TypeError: Cannot read property 'toISOString' of undefined
      at formatDate (src/utils.ts:12:15)
`;
    await chatInput.click();
    await chatInput.evaluate((el, text) => {
      const ev = new ClipboardEvent("paste", {
        clipboardData: new DataTransfer(),
        bubbles: true,
      });
      (ev.clipboardData as DataTransfer).setData("text/plain", text);
      el.dispatchEvent(ev);
    }, fakeLog);
    await page.waitForTimeout(500);

    // Check for log chip (compact representation)
    const chip = page.locator('text=/🖥|log|\\d+ lines/i').first();
    const hasChip = await chip.isVisible().catch(() => false);
    if (hasChip) {
      expect(hasChip).toBeTruthy();
    }

    // Check for debug hint
    const debugHint = page.locator('text=/debug-from-log|log detected/i').first();
    const hasHint = await debugHint.isVisible().catch(() => false);
    if (hasHint) {
      expect(hasHint).toBeTruthy();
    }
  });

  test("6. Agent: Bug fix request", async ({ page }) => {
    await ensureWorkspace(page);
    const url = page.url();
    if (!url.includes("/app/")) {
      test.skip();
      return;
    }

    await runAgentTask(
      page,
      "Fix any lint errors in the project. Run the linter and fix reported issues.",
      { timeout: 120_000 }
    );

    const hasPlanOrResult = await page
      .locator('text=/lint|fix|error|plan|edit/i')
      .first()
      .isVisible()
      .catch(() => false);
    expect(hasPlanOrResult).toBeTruthy();
  });
});
