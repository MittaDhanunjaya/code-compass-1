# Code Compass

Code Compass is a **safety-first, multi-provider AI IDE** for GitHub repos and local projects. It combines an in-browser editor, AI agents (plan + execute), chat, Composer, and CI/PR workflows with sandboxed edits, multi-provider and local LLM support, and debug-from-log.

---

## Table of contents

- [What is Code Compass?](#what-is-code-compass)
- [How to use the application](#how-to-use-the-application)
- [Features and how to use them](#features-and-how-to-use-them)
- [Getting started](#getting-started)
- [Environments](#environments)
- [Configuration](#configuration)
- [CI integration](#ci-integration)
- [Project structure and what to commit](#project-structure-and-what-to-commit)
- [Architecture & API](#architecture--api)
- [Contributing](#contributing)
- [Status and roadmap](#status-and-roadmap)

---

## What is Code Compass?

Code Compass is built for developers who want:

- **Control** — Self-hosted or local engines (Ollama, LM Studio), multiple cloud providers (OpenRouter, OpenAI, Gemini, Perplexity).
- **Safety** — Edits run in a sandbox; lint/tests/run must pass before changes are promoted. Protected paths and over-edit guardrails.
- **Real workflows** — Debug-from-log, CI propose-fixes, PR analysis, and stack-specific lint/test/run commands.

It supports **JS/TS (Next.js/Node), Python, Go, Java, Rust, C#/.NET** and aims to be a serious alternative to Cursor for teams that care about safety and flexibility.

---

## How to use the application

### 1. Install and run

```bash
git clone https://github.com/MittaDhanunjaya/code-compass-1.git
cd code-compass-1
npm install
cp .env.local.example .env.local   # optional: add Supabase and API keys
npm run dev
```

Open the URL shown in the terminal (e.g. `http://localhost:3000`).

### 2. First-time setup (in the app)

1. **Sign in** — Use the auth flow (e.g. email or GitHub if configured).
2. **Add an API key** — **Settings → API Keys**. Add at least one provider (OpenRouter, OpenAI, Gemini, etc.) or configure a local engine (Ollama / LM Studio). Required for Chat, Composer, Agent, and tab completion.
3. **Create a workspace** — In the sidebar, use **New workspace** or **Create**. You can:
   - Start **empty**
   - **Import from GitHub** (repo URL + branch)
   - **Open local folder** (Chrome/Edge: pick a folder; files are uploaded into the workspace)
4. **Optional: Connect GitHub** — **Settings → GitHub** for repo import and (if you use it) CI tokens.

The **first-run checklist** may appear with steps (API key, workspace, try a playbook). You can dismiss it or follow the steps.

### 3. Main interface

- **Left sidebar** — Workspace selector, Project rules, Stack & Commands link, **File tree**, Get started, Settings, User menu.
- **Center** — **Editor** (tabs, Monaco), **Terminal** (toggle with Terminal button or **Ctrl+`**). Terminal shows agent run logs and supports running commands when a workspace is selected.
- **Right panel (optional)** — **Chat**, **Composer**, or **Agent** tab. Switch with the tab buttons.

### 4. Common workflows

- **Edit code** — Open a file from the file tree, edit in the editor, save (Ctrl+S).
- **Quick AI on selection** — Select code → **Cmd+K** (Mac) or **Ctrl+K** (Win) → choose Explain / Refactor / Write tests / Add docs / Fix error / Fix diagnostics. Tab or Cmd+Enter to apply.
- **Chat** — Open Chat tab, type a message. You can paste terminal logs; the app may suggest debugging against the current workspace.
- **Run the Agent** — Open Agent tab, describe a task (or pick a playbook), click Start. The agent plans steps, runs them in a sandbox, and promotes changes if checks pass. Execution logs appear in the Terminal (terminal panel auto-opens when there are logs).
- **Debug from error logs** — Paste a stack trace or error log in Chat, confirm workspace, and use the debug flow. Or use **Ctrl+Shift+P** → “Debug from Log (last error)”.
- **PR review** — Use “Analyze PR” (or the PR analysis API) to get a summary and risk highlights.

---

## Features and how to use them

### Editor and file management

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **File tree** | Use the left sidebar; click to open files. | Navigate and open files in the workspace. |
| **Tabs** | Open files appear as tabs; click to switch, X to close. | Work on multiple files without losing context. |
| **Save** | Ctrl+S (or Save in toolbar). | Persist edits to the workspace. |
| **Go to File** | **Ctrl+P** (or Command palette → “Go to File...”). | Jump to a file by name. |
| **Search in files** | **Ctrl+Shift+F** (or Command palette → “Search in Files”). | Find text across the workspace. |

### AI: Cmd+K (quick actions on selection)

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Explain this** | Select code → Cmd+K → “Explain this”. | Get a short explanation in a dialog. |
| **Refactor this** | Select code → Cmd+K → “Refactor this”. | Get an inline diff to apply (Tab or Cmd+Enter). |
| **Write tests** | Select code → Cmd+K → “Write tests”. | Generate tests for the selection. |
| **Add documentation** | Select code → Cmd+K → “Add documentation”. | Add comments/docs via diff. |
| **Fix error** | Select code (or put cursor near error) → Cmd+K → “Fix error”. | Get a targeted fix suggestion. |
| **Fix diagnostics** | In a file with lint/LSP errors → Cmd+K → “Fix diagnostics”. | Fix reported issues using actual diagnostics as context. |

### Chat

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **General chat** | Open Chat tab, type and send. | Ask questions, get explanations, discuss code. |
| **Paste terminal logs** | Paste logs in the input; if they look like runtime logs, the app can suggest “debug against workspace”. | Turn error logs into code fixes in the right project. |
| **@codebase** | Use “@codebase” and a query in the message. | Search the codebase and include results in the conversation. |

### Composer

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Multi-step edits** | Open Composer tab, describe a task, send. Composer plans and applies edits (with sandbox when applicable). | Accomplish larger tasks (e.g. “add an API and a page”) in one flow. |
| **Scope mode** | Choose Conservative / Normal / Aggressive for how much context is used. | Balance between speed and relevance on big codebases. |

### Agent (plan + execute)

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Describe task** | In Agent tab, type a task (e.g. “Add a README with setup instructions”) and click Start. | Agent produces a plan (file edits + commands) and runs it. |
| **Playbooks** | Use predefined playbooks (e.g. “Fix this failing test”, “Add an API endpoint”, “Add tests for this file”) from the first-run wizard or Agent UI. | One-click starting points for common workflows. |
| **Sandbox** | All Agent (and Composer) runs apply edits in a sandbox; lint/test/run execute there. Changes promote only if checks pass. | Avoid breaking the repo; see “Attempt 1 / Attempt 2” when a retry happens. |
| **Terminal logs** | After a run, execution logs (commands, stdout, stderr) appear in the Terminal panel; the panel auto-opens when there are logs. | Inspect what ran and why something failed. |
| **Scope modes** | Conservative / Normal / Aggressive control how many files are considered. Aggressive + Safe Edit may require confirmation. | Reduce noise on large repos or allow broader context when needed. |
| **Protected paths** | If the plan touches protected paths (e.g. secrets, CI), you’re asked to confirm. | Avoid accidental changes to sensitive areas. |

### Debug from logs

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Paste error in Chat** | Paste a full stack trace or runtime error in Chat; when prompted, confirm the workspace and run debug. | Get suggested code/config fixes tied to the error and your files. |
| **Debug from Log command** | **Ctrl+Shift+P** → “Debug from Log (last error)”. | Quickly re-run or focus the last error in the current workspace. |
| **Best results** | Paste the **full** stack trace (with file paths and line numbers); use Normal or Aggressive scope on larger projects. | Better accuracy and fewer generic suggestions. |

### Command palette and shortcuts

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Command palette** | **Ctrl+Shift+P**. Run: Go to Definition, Find References, Rename Symbol, Run Agent on Current File, Debug from Log, Review All Changes, Go to File, Search in Files. | Fast access to navigation and AI actions. |
| **Go to Definition** | F12 on a symbol (TS/JS/Python where LSP is supported). | Jump to the definition. |
| **Find References** | Shift+F12. | See where a symbol is used. |
| **Rename Symbol** | F2 on a symbol. | Rename with LSP (TS/JS/Python). |
| **Keyboard shortcuts** | Workspace settings or Keyboard shortcuts panel. | View or customize shortcuts (VS Code–style preset). |

### Workspaces and GitHub

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Create workspace** | Sidebar → New/Create; choose empty, GitHub URL, or local folder. | Work on multiple projects; each has its own files and state. |
| **Stack & Commands** | Per-workspace **Stack & Commands** (or `.code-compass/config.json`): define lint, test, run commands per service. | Sandbox and debug-from-log use the right commands for your stack. |
| **Project rules** | “Project rules” in sidebar (or `.code-compass-rules`). | Give the Agent/Composer consistent instructions per project. |
| **Git** | Workspace selector / workspace UI: branch, commit, push, pull (when GitHub is connected). | Keep changes in sync with your repo. |

### Terminal

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Toggle terminal** | Terminal button in the editor toolbar or **Ctrl+`**. | Show or hide the terminal panel. |
| **Agent logs** | After an Agent run, the terminal panel opens automatically when there are logs. | See command output and errors without opening the terminal yourself. |
| **Visibility** | Terminal open/closed state is remembered for the session. | Fewer repeated toggles. |
| **Run commands** | Type in the terminal input and press Enter (when a workspace is selected). | Run shell commands in the context of the app (subject to allowlist where applicable). |

### Settings

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **API Keys** | **Settings → API Keys**. Add one or more providers (OpenRouter, OpenAI, Gemini, Perplexity, Ollama, LM Studio). | Required for AI features; mix cloud and local. |
| **GitHub** | **Settings → GitHub**. Connect for repo import and CI. | Import repos and use CI propose-fixes. |
| **Models / groups** | Configure default models or groups per task (planning, patch, chat, etc.). | Control which model is used where. |

### CI and PR

| Feature | How to use | Why it’s helpful |
|--------|-------------|------------------|
| **Propose fixes (API)** | `POST /api/ci/propose-fixes` with CI logs and workspace ID. Returns suspected root cause, explanation, and edits. | Automate “run tests → on failure, get suggested fixes” in CI. |
| **Apply edits script** | `scripts/apply-code-compass-edits.sh` reads propose-fixes JSON, applies edits, can commit and push. | Integrate Code Compass into your CI pipeline. |
| **PR analyze** | Use “Analyze PR” in the UI or `POST /api/pr/analyze`. | Get a summary and risk highlights for a PR. |

---

## Getting started

### Clone and install

```bash
git clone https://github.com/MittaDhanunjaya/code-compass-1.git
cd code-compass-1
npm install
```

### Environment (optional)

Copy `.env.local.example` to `.env.local` and set:

- Supabase URL and anon key (if using Supabase for auth and data).
- Any provider API keys you want as defaults (otherwise add them in the app under Settings → API Keys).

### Run in development

```bash
npm run dev
```

Open the URL printed in the terminal.

### Build for production

```bash
npm run build
npm start
```

### Run tests

```bash
npm run test
```

### Environments

Code Compass uses `NODE_ENV` to distinguish environments:

| Command | Environment | NODE_ENV | Use case |
|---------|--------------|----------|----------|
| `npm run dev` | Development | `development` | Local development with hot reload, dev tools, `X-Dev-Token` auth bypass, debug routes |
| `npm run build` + `npm run start` | Production | `production` | Production build; preflight checks block startup if critical systems fail; auth required |
| `npm run test` | Test | `test` | Unit tests (Vitest); metrics and logging are skipped |

- **Development** — Default for `npm run dev`. Hot reload, dev-only features (e.g. `/api/debug/*`), optional `DEV_OPENROUTER_API_KEY`.
- **Production** — Used by `npm run start` after `npm run build`. Preflight gate runs at startup; no dev bypasses.
- **Test** — Set by Vitest when running `npm run test`. Used for automated tests, not a running app.

### Lint

```bash
npm run lint
```

---

## Configuration

- **Per-workspace stack** — `.code-compass/config.json` in the repo (or via Stack & Commands in the UI): `services[]` with `name`, `root`, `stack`, `lintCommand`, `testCommand`, `runCommand`. Used by the sandbox and debug-from-log.
- **Per-workspace rules** — Project rules (e.g. `.code-compass-rules`) for Agent/Composer behavior.
- **Env overrides** — Task routing and provider behavior can be tuned via environment variables; see `lib/llm/task-routing.ts` and provider code.

---

## Resilience & Fallbacks

Code Compass handles common environment and quota failures to avoid crashes and improve DX:

- **Port collision** — If port 3000 is busy, `npm run dev` and `npm start` automatically pick a free port in 3001–3100 and log `Port 3000 busy → using PORT=<port>`. Cross-platform (macOS/Linux/Windows).
- **NODE_ENV guardrail** — If `NODE_ENV` is invalid or unset, it is auto-set to `development` for `next dev` and `production` for `next start`, with a warning.
- **Preflight** — Before `dev`, `start`, and `test`, the preflight checks that required scripts (`dev`, `build`, `start`, `test`) and binaries (`next`, `vitest`) exist. If missing, it prints remediation commands and exits non-zero.
- **Healthcheck** — Run `npm run healthcheck` in CI to validate ports, `NODE_ENV`, scripts, binaries, and AI provider config. Exits 0 if all pass.
- **AI provider fallback** — On 429, quota, or rate-limit, the LLM router retries with the next configured provider. Structured logs: `{ provider, model, reason, retryingWith }`. Set `AI_PROVIDERS_ENABLED=false` to disable AI calls. When all providers fail, the UI receives `AI_TEMPORARILY_UNAVAILABLE` (503) instead of crashing.

### Streaming Resilience

The AI streaming pipeline guarantees either streamed tokens or a final structured error event—never silent completion. On stream failure (429, timeout, network, provider error), the chat stream emits `{ "type": "error", "code": "AI_STREAM_FAILED", "provider", "model", "reason" }` and falls back to non-streaming completion. If the fallback also fails, the UI receives `AI_TEMPORARILY_UNAVAILABLE`. Frontend stream consumers (agent plan/execute hooks) handle empty stream, premature close, and error event frames; display a visible error instead of infinite loading.

---

## CI integration

Example GitHub Actions job: on test failure, call Code Compass propose-fixes and apply edits.

```yaml
jobs:
  test-and-propose-fixes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install deps
        run: npm ci
      - name: Run tests
        run: npm test || echo "Tests failed" > test_failed.txt
      - name: Propose fixes from Code Compass
        if: failure()
        run: |
          LOG=$(cat test_failed.txt || echo "")
          curl -sS -X POST \
            -H "Authorization: Bearer ${{ secrets.CODE_COMPASS_CI_TOKEN }}" \
            -H "Content-Type: application/json" \
            "${{ vars.CODE_COMPASS_URL }}/api/ci/propose-fixes?workspaceId=${{ vars.CODE_COMPASS_WORKSPACE_ID }}" \
            -d "{\"logText\": \"$LOG\"}" \
          | ./scripts/apply-code-compass-edits.sh --branch "cc-fix-$(date +%s)" --push
```

See `docs/CI_PROPOSE_FIXES.md` for detailed setup (tokens, workspace ID, apply script options).

---

## Project structure and what to commit

Important paths to keep in Git:

- `app/` — Next.js app and API routes.
- `components/` — UI components.
- `lib/` — Shared logic (LLM, agent, sandbox, indexing, etc.).
- `scripts/` — CI and eval scripts (e.g. `apply-code-compass-edits.sh`).
- `supabase/migrations/` — Database migrations.
- `package.json`, `package-lock.json`, config files (`next.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, etc.).
- `README.md` and `docs/*.md` (user and contributor documentation).
- `.env.local.example` (no secrets).
- `.github/` — Workflow templates.

Unnecessary or generated files are listed in `.gitignore` (e.g. `node_modules/`, `.next/`, `.env.local`, build artifacts, IDE/OS cruft). Only source, config, and docs that others need should be committed.

---

## Architecture & API

### Architecture

Code Compass is a Next.js 15 app with:

- **Frontend**: React, Tailwind, Radix UI, Monaco Editor
- **Backend**: Next.js API routes, Supabase (auth + Postgres)
- **AI**: Multi-provider LLM router (OpenRouter, OpenAI, Gemini, Ollama, LM Studio, etc.)
- **Indexing**: Vector embeddings for semantic search, symbol graph for LSP

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React)                                                 │
│  ├── App Shell (workspace selector, file tree, AI panel)         │
│  ├── Editor Area (Monaco, LSP integration)                       │
│  ├── Chat / Agent / Composer panels                             │
│  └── Terminal panel                                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js API Routes                                              │
│  ├── requireAuth / requireWorkspaceAccess                        │
│  ├── rate limiting (lib/api-rate-limit)                          │
│  └── thin controllers → services                                │
└─────────────────────────────────────────────────────────────────┘
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Services        │ │  lib/llm/router   │ │  Supabase         │
│  ├── agent       │ │  ├── invoke       │ │  ├── auth         │
│  ├── chat        │ │  ├── providers    │ │  ├── workspaces   │
│  ├── composer    │ │  └── budget guard │ │  ├── provider_keys│
│  └── vector      │ │  Sandbox (lib/    │ │  └── embeddings   │
└──────────────────┘ │  sandbox)        │ └──────────────────┘
                     └──────────────────┘
```

**Key flows:**

- **LLM**: Router (`lib/llm/router.ts`) → budget guard → task routing → providers. Per-user and per-workspace token limits; 429 when over.
- **Agent**: Plan (`/api/agent/plan-stream`) → Execute (`/api/agent/execute-stream`) → sandbox with tools. Registry validates tool names and inputs.
- **Chat**: Stream (`/api/chat/stream`) → messages + workspace context → LLM stream → SSE. Max 60s stream duration.

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

### API Reference

- **Auth**: Protected routes use `requireAuth(request)` or `requireWorkspaceAccess(request, workspaceId)`. 401 = no session; 403 = forbidden.
- **Rate limits**: Chat 60/min; agent, composer, inline-edit 30/min per user or IP. Returns 429 with `Retry-After` when over.
- **Budget**: Per-user and per-workspace daily token limits. Returns 429 `BUDGET_EXCEEDED` when exceeded.

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/chat/stream` | POST | yes | Streaming chat. Body: `{ messages, workspaceId?, ... }`. |
| `/api/agent/plan-stream` | POST | yes | Streaming plan. Body: `{ instruction, workspaceId, scopeMode?, ... }`. |
| `/api/agent/execute-stream` | POST | yes | Streaming execution. Body: `{ plan, workspaceId, ... }`. |
| `/api/workspaces/[id]/debug-from-log` | POST | yes | Debug from error log. |
| `/api/ci/propose-fixes` | POST | yes or CI token | Propose fixes from CI logs. |
| `/api/health` | GET | no | Health check. |

Full reference: [docs/API.md](docs/API.md)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run locally, code style, and the PR checklist.

**Documentation**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | [docs/API.md](docs/API.md) | [docs/PRODUCTION_HARDENING_CHANGES.md](docs/PRODUCTION_HARDENING_CHANGES.md)

---

## Status and roadmap

- **Supported stacks** — JS/TS (Next.js/Node), Python, Go, Java, Rust, C#/.NET.
- **Deployment** — Self-hosted (Next.js + Supabase). Electron desktop build scripts exist (`electron/`, `docs/ELECTRON_BUILD.md`).
- **Short-term** — Signed installers, optional hosted preview, more reliability and eval work.

When to choose Code Compass vs Cursor:

- **Code Compass** — Self-hosting or multi-provider (including local) matters; safety, sandboxing, and CI/PR are first-class; you’re fine with a browser/Electron app.
- **Cursor** — You prefer a VS Code–native experience and a fully managed, cloud-centric product.

Both can coexist; Code Compass is the safety-first, self-hosted, multi-provider option in your toolbox.
