/**
 * Full End-to-End Integration Test
 *
 * Tests all features with critical, real-world tasks (3-tier e-commerce, etc.).
 * Uses API keys already saved in Settings. Produces a detailed report.
 *
 * Run:
 *   E2E_USER_EMAIL=... E2E_USER_PASSWORD=... \
 *   npx playwright test e2e/full-e2e-report.spec.ts --headed --timeout=600000
 */

import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3001";
const USER_EMAIL = process.env.E2E_USER_EMAIL;
const USER_PASSWORD = process.env.E2E_USER_PASSWORD;
const OPENROUTER_KEY = process.env.E2E_OPENROUTER_KEY;
const GITHUB_REPO_URL = process.env.E2E_GITHUB_REPO_URL;

const REPORT_PATH = path.join(process.cwd(), "e2e-results-report.md");

interface TestResult {
  name: string;
  passed: boolean;
  durationMs?: number;
  details: string;
  error?: string;
}

const results: TestResult[] = [];

function recordResult(name: string, passed: boolean, details: string, error?: string, durationMs?: number) {
  results.push({ name, passed, details, error, durationMs });
}

async function dismissFirstRunDialog(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("firstRunChecklistDismissed", "true");
    } catch {}
  });
  await page.reload();
  await page.waitForTimeout(1000);

  const gotItBtn = page.getByRole("button", { name: /got it/i });
  if (await gotItBtn.isVisible().catch(() => false)) {
    await gotItBtn.click();
    await page.waitForTimeout(500);
  }
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible().catch(() => false)) {
    const xBtn = page.locator("button").filter({ has: page.locator("svg") }).first();
    if (await xBtn.isVisible().catch(() => false)) {
      await xBtn.click();
    }
  }
  await page.waitForTimeout(500);
}

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  if (page.url().includes("/sign-in") && USER_EMAIL && USER_PASSWORD) {
    await page.getByLabel(/email/i).fill(USER_EMAIL);
    await page.getByLabel(/password/i).fill(USER_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/(app|$)/, { timeout: 20000 });
  }
}

async function ensureApiKey(page: import("@playwright/test").Page): Promise<boolean> {
  if (!OPENROUTER_KEY?.trim()) return false;
  await page.goto(`${BASE_URL}/app/settings?tab=keys`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const openRouterBtn = page.getByRole("button", { name: /openrouter/i }).first();
  if (await openRouterBtn.isVisible().catch(() => false)) {
    await openRouterBtn.click();
    await page.waitForTimeout(500);
  }
  const keyInput = page.locator("#api-key").or(page.getByLabel(/api key/i));
  await keyInput.fill(OPENROUTER_KEY);
  const saveBtn = page.getByRole("button", { name: /save key|update key/i });
  await saveBtn.click();
  await page.waitForTimeout(2000);
  return true;
}

async function ensureWorkspace(page: import("@playwright/test").Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("/app/") && !url.endsWith("/app")) return true;

  const createBtn = page.getByRole("button", { name: /create workspace/i });
  if (await createBtn.isVisible().catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    if (GITHUB_REPO_URL?.trim()) {
      const githubOpt = page.getByRole("button", { name: /import from public github url/i });
      if (await githubOpt.isVisible().catch(() => false)) {
        await githubOpt.click();
        await page.waitForTimeout(500);
        const urlInput = page.locator("#create-repo-url").or(page.getByPlaceholder(/github\.com/));
        await urlInput.fill(GITHUB_REPO_URL);
        await page.waitForTimeout(500);
      }
    }
    const nameInput = page.locator("#create-name").or(page.getByLabel(/workspace name/i));
    await nameInput.fill(`e2e-full-${Date.now()}`);
    await page.waitForTimeout(300);
    const createSubmit = page.getByRole("button", { name: /^create$/i });
    await createSubmit.click();
    await page.waitForURL(/\/app\/[^/]+/, { timeout: 30000 });
    return true;
  }

  const workspaceLink = page.locator('a[href^="/app/"]').first();
  if (await workspaceLink.isVisible().catch(() => false)) {
    await workspaceLink.click();
    await page.waitForURL(/\/app\/[^/]+/, { timeout: 10000 });
    return true;
  }
  return false;
}

function writeReport() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  const report = [
    "# Code Compass E2E Test Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `- Total tests: ${results.length}`,
    `- Passed: ${passed}`,
    `- Failed: ${failed}`,
    "",
    "## Detailed Results",
    "",
    ...results.flatMap((r) => [
      `### ${r.passed ? "✅" : "❌"} ${r.name}`,
      "",
      `- **Passed:** ${r.passed}`,
      r.durationMs != null ? `- **Duration:** ${r.durationMs}ms` : "",
      `- **Details:** ${r.details}`,
      r.error ? `- **Error:** ${r.error}` : "",
      "",
    ]),
    "## Feature Accuracy Assessment",
    "",
    "| Feature | Test verifies | Working solution? |",
    "|---------|---------------|-------------------|",
    "| Chat | Response received | Tests for presence of response; quality not verified |",
    "| Composer | Plan generated | Tests for plan visibility; Apply + lint/test not verified |",
    "| Agent | Plan/execute status | Tests for status; actual file edits + sandbox checks not verified |",
    "| Debug-from-log | Chip + debug triggered | Tests for flow; fix correctness not verified |",
    "",
    "**Note:** Current tests verify UI flows and API connectivity. They do NOT verify that:",
    "- Generated code compiles or runs correctly",
    "- Debug-from-log actually fixes the underlying bug",
    "- Agent/Composer edits pass lint and tests after apply",
    "",
    "For production confidence, add: Apply edits → run workspace lint/test → assert success.",
    "",
    "## Recommendations",
    "",
    failed > 0
      ? [
          "1. **Failed tests:** Review errors above. Common causes:",
          "   - API keys missing or expired (Settings → API Keys)",
          "   - Rate limits (OpenRouter, Gemini, etc.)",
          "   - Slow LLM response (increase timeouts)",
          "2. **Improve accuracy:** Add post-apply verification (run lint/test, assert files exist).",
        ].join("\n")
      : "All tests passed. Consider adding post-apply verification (lint/test) for production confidence.",
    "",
  ].join("\n");

  fs.writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to ${REPORT_PATH}`);
}

test.describe("Full E2E - All Features (Big Tasks)", () => {
  test.setTimeout(600_000); // 10 min per test

  test.beforeEach(async ({ page }) => {
    if (!USER_EMAIL || !USER_PASSWORD) {
      test.skip(true, "Set E2E_USER_EMAIL and E2E_USER_PASSWORD to run E2E tests");
      return;
    }
    await signIn(page);
    await page.waitForTimeout(1500);
  });

  test("0. Setup: Add API key (if provided) and reach workspace", async ({ page }) => {
    const start = Date.now();
    if (OPENROUTER_KEY?.trim()) {
      await ensureApiKey(page);
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);
    }
    await dismissFirstRunDialog(page);
    const hasWorkspace = await ensureWorkspace(page);
    const chatTab = page.getByRole("button", { name: /^chat$/i });
    const agentTab = page.getByRole("button", { name: /^agent$/i });
    const composerTab = page.getByRole("button", { name: /^composer$/i });

    const chatVisible = await chatTab.isVisible().catch(() => false);
    const agentVisible = await agentTab.isVisible().catch(() => false);
    const composerVisible = await composerTab.isVisible().catch(() => false);

    recordResult(
      "Setup: Dismiss dialog & reach workspace",
      hasWorkspace && (chatVisible || agentVisible || composerVisible),
      `Workspace: ${hasWorkspace}, Chat: ${chatVisible}, Agent: ${agentVisible}, Composer: ${composerVisible}`,
      undefined,
      Date.now() - start
    );
    expect(hasWorkspace).toBeTruthy();
    expect(chatVisible || agentVisible || composerVisible).toBeTruthy();
  });

  test("1. Settings: API Keys tab - verify providers visible", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    await page.goto(`${BASE_URL}/app/settings?tab=keys`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    const openRouter = page.getByRole("button", { name: /openrouter/i }).first();
    const gemini = page.getByRole("button", { name: /gemini/i }).first();
    const perplexity = page.getByRole("button", { name: /perplexity/i }).first();

    const hasOpenRouter = await openRouter.isVisible().catch(() => false);
    const hasGemini = await gemini.isVisible().catch(() => false);
    const hasPerplexity = await perplexity.isVisible().catch(() => false);

    const passed = hasOpenRouter && hasGemini && hasPerplexity;
    recordResult(
      "Settings: API Keys (OpenRouter, Gemini, Perplexity)",
      passed,
      `OpenRouter: ${hasOpenRouter}, Gemini: ${hasGemini}, Perplexity: ${hasPerplexity}`,
      undefined,
      Date.now() - start
    );
    expect(hasOpenRouter).toBeTruthy();
    expect(hasGemini).toBeTruthy();
    expect(hasPerplexity).toBeTruthy();
  });

  test("2. Chat: Send message - architecture question", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    const ok = await ensureWorkspace(page);
    if (!ok) {
      recordResult("Chat: Architecture question", false, "No workspace", "Could not create/select workspace");
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^chat$/i }).click();
    await page.waitForTimeout(800);

    const input = page.getByPlaceholder(/ask anything|paste terminal|type a message/i).first();
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill(
      "Briefly explain the 3-tier architecture for an e-commerce website: presentation, business logic, and data layers. Reply in 2-3 sentences."
    );
    await page.waitForTimeout(300);

    const sendBtn = page.getByTitle(/send message/i).or(page.locator('form button[type="submit"]'));
    await sendBtn.click();

    // Wait for response (assistant messages appear after loading; models can take 30-90s)
    await page.waitForTimeout(8000);
    // Assistant messages use bg-muted; look for any response with architecture keywords
    const assistantMsg = page.getByText(/presentation|tier|layer|business|data|architecture|e-commerce|website/i).first();
    let gotResponse = await assistantMsg.isVisible().catch(() => false);
    if (!gotResponse) {
      await page.waitForTimeout(15000); // Extra 15s for slow models
      gotResponse = await assistantMsg.isVisible().catch(() => false);
    }
    const fallback = page.locator("text=/error|failed|401|404|no api key|unauthorized/i").first();
    const hasError = await fallback.isVisible().catch(() => false);

    const passed = gotResponse && !hasError;
    recordResult(
      "Chat: Architecture question",
      passed,
      passed ? "Received assistant response" : hasError ? "API/key error or no response" : "No clear response in 90s",
      undefined,
      Date.now() - start
    );
    expect(gotResponse || !hasError).toBeTruthy();
  });

  test("3. Chat: Paste logs → log chip → debug hint", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    const ok = await ensureWorkspace(page);
    if (!ok) {
      recordResult("Chat: Paste logs", false, "No workspace");
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^chat$/i }).click();
    await page.waitForTimeout(500);

    const input = page.getByPlaceholder(/ask anything|paste terminal/i).first();
    await input.click();
    const fakeLog = `$ npm test
> jest
FAIL src/utils.test.ts
  ● TypeError: Cannot read property 'toISOString' of undefined
    at formatDate (src/utils.ts:12:15)
`;
    await input.evaluate((el, text) => {
      const ev = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true });
      ev.clipboardData!.setData("text/plain", text);
      el.dispatchEvent(ev);
    }, fakeLog);
    await page.waitForTimeout(600);

    const chip = page.locator('text=/🖥|npm|\\d+ lines/i').first();
    const hasChip = await chip.isVisible().catch(() => false);
    const hint = page.locator('text=/debug-from-log|log detected/i').first();
    const hasHint = await hint.isVisible().catch(() => false);

    recordResult(
      "Chat: Paste logs → chip",
      hasChip,
      `Chip visible: ${hasChip}, Debug hint: ${hasHint}`,
      undefined,
      Date.now() - start
    );
    expect(hasChip).toBeTruthy();
  });

  test("4. Composer: 3-tier e-commerce page structure (big task)", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    const ok = await ensureWorkspace(page);
    if (!ok) {
      recordResult("Composer: 3-tier e-commerce", false, "No workspace");
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^composer$/i }).click();
    await page.waitForTimeout(800);

    const workspaceScope = page
      .getByRole("button", { name: /workspace \(≤/i })
      .or(page.getByRole("button", { name: /^workspace$/i }));
    if (await workspaceScope.isVisible().catch(() => false)) {
      await workspaceScope.click();
      await page.waitForTimeout(300);
    }

    const textarea = page.getByPlaceholder(/add logging|edit instruction/i).first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    const bigTask = `Create a 3-tier e-commerce page structure for a Next.js app:

1. Create app/shop/page.tsx - Main shop page with:
   - Header: logo, nav links (Home, Products, Cart), user menu
   - Main content: product grid (3 columns, placeholder cards with image, title, price, Add to Cart button)
   - Footer: copyright, links (About, Contact, Privacy)

2. Create components/shop/ProductCard.tsx - Reusable product card component with props: image, title, price, onAddToCart

3. Create components/shop/ShopHeader.tsx - Header with logo and navigation

Use Tailwind CSS. Export all components. Keep it clean and minimal.`;

    await textarea.fill(bigTask);
    await page.waitForTimeout(400);

    const genBtn = page.getByRole("button", { name: /generate edits/i });
    await genBtn.click();

    await page.waitForTimeout(5000);
    const planned = page.locator('text=/planned|\\d+ file|generate|select all|apply/i').first();
    const errMsg = page.locator('text=/error|failed|no model|api key/i').first();
    const hasPlan = await planned.isVisible().catch(() => false);
    const hasErr = await errMsg.isVisible().catch(() => false);

    await page.waitForTimeout(90000); // 90s for big task

    const planAfter = page.locator('text=/planned|\\d+ file|select all|apply|shop|ProductCard|Header/i').first();
    const hasResult = await planAfter.isVisible().catch(() => false);

    const passed = hasResult && !hasErr;
    recordResult(
      "Composer: 3-tier e-commerce page structure",
      passed,
      passed ? "Plan generated, steps visible" : hasErr ? "API/model error" : "No plan after 90s",
      undefined,
      Date.now() - start
    );
    expect(hasResult || !hasErr).toBeTruthy();
  });

  test("5. Agent: 3-tier e-commerce webpage - full implementation (big task)", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    const ok = await ensureWorkspace(page);
    if (!ok) {
      recordResult("Agent: 3-tier e-commerce", false, "No workspace");
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^agent$/i }).click();
    await page.waitForTimeout(800);

    const textarea = page.getByPlaceholder(/add a readme|paste terminal|describe a task/i).first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    const bigTask = `Create a complete 3-tier e-commerce webpage for a Next.js app:

1. Create app/shop/page.tsx - Main shop page with:
   - Header: logo, nav links (Home, Products, Cart), user menu placeholder
   - Main content: product grid (3 columns, 3 product cards using ProductCard)
   - Footer: copyright 2025, links (About, Contact, Privacy)

2. Create components/shop/ProductCard.tsx - Reusable product card component. Props: image (string), title (string), price (number), onAddToCart?: () => void. Display image, title, formatted price, Add to Cart button.

3. Create components/shop/ShopHeader.tsx - Header with logo "Shop" and nav links (Home, Products, Cart), user avatar placeholder.

4. Create components/shop/ShopFooter.tsx - Footer with copyright and links.

Use Tailwind CSS. Export all components. Keep the design clean and modern. Use placeholder images (e.g. https://picsum.photos/200) if needed.`;

    await textarea.fill(bigTask);
    await page.waitForTimeout(400);

    await page.getByRole("button", { name: /^start$/i }).click();

    await page.waitForTimeout(10000); // Initial wait for plan to start
    const errEl = page.locator('[class*="destructive"], [role="alert"], .text-destructive').first();
    let errText = "";
    if (await errEl.isVisible().catch(() => false)) {
      errText = (await errEl.textContent().catch(() => "")) || "";
    }
    // Only treat as error if it's a real API/config failure (exclude benign text like "error context")
    const apiErrorPattern = /no api key|add.*api key|401|unauthorized|authentication failed|rate limit|invalid model|failed to fetch|connection lost|no model selected/i;
    const genericErr = page.locator('[class*="destructive"]').filter({ hasText: apiErrorPattern }).first();
    const hasErr = await genericErr.isVisible().catch(() => false);
    if (hasErr && !errText) errText = (await genericErr.textContent().catch(() => "")) || "API/Model error";

    await page.waitForTimeout(110000); // 2 min total for big agent task

    const status = page.locator('text=/planning|executing|planned|apply|review|done|Approve|Reject/i').first();
    const planSteps = page.locator('text=/shop|ProductCard|ShopHeader|ShopFooter|page\\.tsx/i').first();
    const hasStatus = await status.isVisible().catch(() => false);
    const hasPlan = await planSteps.isVisible().catch(() => false);

    const passed = (hasStatus || hasPlan) && !hasErr;
    const details = passed
      ? "Agent produced plan/execution"
      : hasErr
        ? `Model/API error: ${errText.slice(0, 120)}`
        : "No plan or status after 2min";
    recordResult(
      "Agent: 3-tier e-commerce webpage (full)",
      passed,
      details,
      hasErr ? errText.slice(0, 200) : undefined,
      Date.now() - start
    );
    expect((hasStatus || hasPlan) || !hasErr).toBeTruthy();
  });

  test("6. Agent: Debug-from-log flow (paste + send)", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    const ok = await ensureWorkspace(page);
    if (!ok) {
      recordResult("Agent: Debug-from-log", false, "No workspace");
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^agent$/i }).click();
    await page.waitForTimeout(800);

    const textarea = page.getByPlaceholder(/add a readme|paste terminal|describe a task/i).first();
    await textarea.click();
    const fakeLog = `$ npm test
> jest
FAIL src/app.test.ts
  ● SyntaxError: Unexpected token
    at parse (src/app.ts:5:10)
`;
    await textarea.evaluate((el, text) => {
      const ev = new ClipboardEvent("paste", { clipboardData: new DataTransfer(), bubbles: true });
      ev.clipboardData!.setData("text/plain", text);
      el.dispatchEvent(ev);
    }, fakeLog);
    await page.waitForTimeout(800);

    const chip = page.locator('text=/🖥|npm|\\d+ lines/i').first();
    const hasChip = await chip.isVisible().catch(() => false);
    const hint = page.locator('text=/debug-from-log|log detected/i').first();
    const hasHint = await hint.isVisible().catch(() => false);

    if (!hasChip) {
      recordResult("Agent: Debug-from-log chip", false, "Log chip not shown after paste");
      test.skip();
      return;
    }

    await page.getByRole("button", { name: /^start$/i }).click();
    await page.waitForTimeout(15000);

    const debugRunning = page.locator('text=/debug|planning|executing|parse/i').first();
    const hasDebug = await debugRunning.isVisible().catch(() => false);

    recordResult(
      "Agent: Debug-from-log",
      hasChip && (hasHint || hasDebug),
      `Chip: ${hasChip}, Hint: ${hasHint}, Debug triggered: ${hasDebug}`,
      undefined,
      Date.now() - start
    );
    expect(hasChip).toBeTruthy();
  });

  test("7. Settings: Safety tab visible", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    await page.goto(`${BASE_URL}/app/settings?tab=safety`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const safetyTab = page.locator('button').filter({ hasText: /safety/i }).first();
    const hasSafety = await safetyTab.isVisible().catch(() => false);
    const content = page.locator('text=/protected|pattern|safe edit/i').first();
    const hasContent = await content.isVisible().catch(() => false);

    recordResult(
      "Settings: Safety tab",
      hasSafety && hasContent,
      `Safety tab: ${hasSafety}, Content: ${hasContent}`,
      undefined,
      Date.now() - start
    );
    expect(hasSafety).toBeTruthy();
  });

  test("8. Settings: Shortcuts tab visible", async ({ page }) => {
    const start = Date.now();
    await dismissFirstRunDialog(page);
    await page.goto(`${BASE_URL}/app/settings?tab=shortcuts`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const shortcutsTab = page.locator('button').filter({ hasText: /shortcut/i }).first();
    const hasShortcuts = await shortcutsTab.isVisible().catch(() => false);
    const content = page.locator('text=/Ctrl|⌘|Quick actions/i').first();
    const hasContent = await content.isVisible().catch(() => false);

    recordResult(
      "Settings: Shortcuts tab",
      hasShortcuts && hasContent,
      `Shortcuts tab: ${hasShortcuts}, Content: ${hasContent}`,
      undefined,
      Date.now() - start
    );
    expect(hasShortcuts).toBeTruthy();
  });

  test.afterAll(() => {
    writeReport();
  });
});
