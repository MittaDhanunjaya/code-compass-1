# Code Compass API Reference

API routes and their auth, rate limits, and usage.

---

## Overview

All API routes live under `/api/`. Sensitive routes require authentication via `requireAuth(request)`. LLM endpoints are rate-limited per user or IP.

---

## Authentication

- **Protected routes**: Call `requireAuth(request)` or `requireWorkspaceAccess(request, workspaceId)`.
- **Bypass (dev only)**: `X-Dev-Token` with `DEV_TEST_TOKEN` when `NODE_ENV=development`.
- **401**: No valid session; frontend should redirect to sign-in.
- **403**: Authenticated but forbidden (e.g. workspace not owned/member).

---

## Rate Limiting

| Route | Limit | Scope |
|-------|-------|-------|
| `/api/chat/stream` | 60/min | user or IP |
| `/api/agent/plan-stream`, `/api/agent/execute-stream` | 30/min | user or IP |
| `/api/composer/plan`, `/api/composer/execute` | 30/min | user or IP |
| `/api/pr/analyze` | 30/min | user or IP |
| `/api/inline-edit` | 30/min | user or IP |
| `/api/completions/tab` | 60/min | user or IP |

Backend: Redis when `REDIS_URL` is set; in-memory fallback otherwise. Returns `429` with `Retry-After` when over limit.

---

## Key Routes

### Chat

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/chat` | POST | yes | Non-streaming chat completion. |
| `/api/chat/stream` | POST | yes | Streaming chat. Body: `{ messages, workspaceId?, ... }`. |
| `/api/chat/save-message` | POST | yes | Persist a message to history. |
| `/api/chat/history` | GET | yes | Fetch chat history for workspace. |

### Agent

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/agent/plan` | POST | yes | Non-streaming plan generation. |
| `/api/agent/plan-stream` | POST | yes | Streaming plan. Body: `{ instruction, workspaceId, scopeMode?, ... }`. |
| `/api/agent/execute` | POST | yes | Non-streaming plan execution. |
| `/api/agent/execute-stream` | POST | yes | Streaming execution. Body: `{ plan, workspaceId, ... }`. |
| `/api/agent/run-command` | POST | yes | Run a single command in workspace sandbox. |
| `/api/workspaces/[id]/agent/apply-edits` | POST | yes | Apply edits from Agent/Composer. Must be workspace member. |

### Composer

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/composer/plan` | POST | yes | Generate Composer plan. |
| `/api/composer/execute` | POST | yes | Execute Composer plan. |

### Workspaces

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/workspaces` | GET, POST | yes | List or create workspaces. |
| `/api/workspaces/[id]` | GET, PATCH, DELETE | yes | Get, update, or delete. PATCH/DELETE owner only. |
| `/api/workspaces/[id]/files` | GET | yes | List workspace files. |
| `/api/workspaces/[id]/files/sync` | POST | yes | Sync files from folder/GitHub. |
| `/api/workspaces/[id]/debug-from-log` | POST | yes | Debug from error log. Body: `{ logText, provider?, model?, scopeMode? }`. |
| `/api/workspaces/[id]/index-status` | GET | yes | Index status and file count. |
| `/api/workspaces/[id]/lint` | POST | yes | Run lint on workspace. |

### CI & PR

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/ci/propose-fixes` | POST | yes or CI token | Propose fixes from CI logs. Uses `CODE_COMPASS_CI_TOKEN` when provided. |
| `/api/pr/analyze` | POST | yes | Analyze PR diff. Body: `{ diffText, workspaceId?, provider?, model? }`. |

### Other

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/health` | GET | no | Health check. Returns `{ status: "ok" }`. |
| `/api/version` | GET | no | App version. |
| `/api/search` | POST | yes | Semantic search over workspace index. |
| `/api/inline-edit` | POST | yes | Cmd+K inline edit (refactor, explain, etc.). |
| `/api/completions/tab` | POST | yes | Tab completion. |

---

## Debug Routes (development only)

When `NODE_ENV !== "development"`, these return 404:

- `/api/debug/provider-keys` – List provider keys (admin only).
- `/api/debug/reset-keys` – Reset keys (admin only).

Admin: `ADMIN_USER_IDS` env (comma-separated Supabase user IDs).
