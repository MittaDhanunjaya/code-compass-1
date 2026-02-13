# Code Compass Architecture

High-level architecture and data flow.

---

## Overview

Code Compass is a Next.js 15 app with:

- **Frontend**: React, Tailwind, Radix UI, Monaco Editor
- **Backend**: Next.js API routes, Supabase (auth + Postgres)
- **AI**: Multi-provider LLM router (OpenRouter, OpenAI, Gemini, Ollama, LM Studio, etc.)
- **Indexing**: Vector embeddings for semantic search, symbol graph for LSP

---

## Layer Diagram

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
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Services        │ │  lib/llm/router   │ │  Supabase         │
│  ├── agent       │ │  ├── invoke       │ │  ├── auth         │
│  ├── chat        │ │  ├── providers   │ │  ├── workspaces   │
│  ├── composer    │ │  └── token budget│ │  ├── provider_keys│
│  ├── evaluation  │ │                  │ │  └── embeddings   │
│  └── vector      │ │  Sandbox (lib/   │ │                  │
└──────────────────┘ │  sandbox)        │ └──────────────────┘
                     └──────────────────┘
```

---

## Key Directories

| Path | Purpose |
|------|---------|
| `app/` | Next.js app router pages and API routes |
| `components/` | React UI components |
| `lib/` | Utilities, auth, LLM router, validation, sandbox |
| `services/` | Business logic (agent, chat, composer, evaluation, vector) |
| `hooks/` | React hooks (useAgentPlan, useAgentExecute, useUndoRedo) |
| `e2e/` | Playwright E2E tests |

---

## LLM Flow

1. **Router** (`lib/llm/router.ts`): Single entry for all LLM calls. Enforces token budgets, timeouts, retries.
2. **Task routing**: Picks model per task (planning, patch, chat, debug) from user preferences or best-default.
3. **Providers**: OpenRouter, OpenAI, Gemini, Perplexity, Ollama, LM Studio. Keys from DB (encrypted) or env.
4. **Token budget**: Per-user and per-workspace limits. Returns 429 when over.

---

## Agent Flow

1. **Plan** (`/api/agent/plan-stream`): User instruction → LLM → structured plan (steps: file_edit, command).
2. **Execute** (`/api/agent/execute-stream`): Plan → sandbox → run steps (read_file, edit_file, run_command) → promote if checks pass.
3. **Tools**: Registry in `services/tools/registry.ts`. Validates tool name and input.
4. **Sandbox**: `lib/sandbox/` runs commands, applies edits. Fails fast on lint/test/run errors.

---

## Chat Flow

1. **Stream** (`/api/chat/stream`): Messages + workspace context → LLM stream → SSE to client.
2. **Context**: @codebase queries go through semantic search; rules from `.code-compass-rules`.
3. **Debug from logs**: Paste log → suggest debug → run `debug-from-log` with workspace files.

---

## Data Model (Supabase)

- **auth.users**: Supabase Auth
- **workspaces**: Owner, name, github_repo, github_current_branch
- **workspace_files**: path, content (per workspace)
- **workspace_members**: Sharing (owner + members)
- **provider_keys**: Encrypted API keys per user
- **embeddings**: Vector index for semantic search

---

## Tooling vs AI (Critical Separation)

**Never use LLMs for deterministic tasks.** Use native tools instead.

| Task | Tool | AI |
|------|------|-----|
| Formatting | Prettier, Black, gofmt, clang-format, rustfmt | ❌ |
| Linting | ESLint, Ruff, etc. (run in sandbox) | ❌ |
| Validation | Zod | ❌ |
| Diffs | Monaco diff editor | ❌ |
| File ops | Native FS, Supabase | ❌ |
| Planning | — | ✓ |
| Reasoning | — | ✓ |
| Refactoring | — | ✓ (optional) |

**Implementation**:
- `lib/formatters` — Prettier, Black, gofmt, etc. No LLM.
- `prepareEditContent()` — Escape normalization + deterministic formatter before applying any edit.
- Sandbox runs lint/test/run via stack commands (ESLint, pytest, etc.).
- LLM output parsing: `parseJSONRobust`, Zod schemas — never ask LLM to "validate" or "format".

---

## Security

- Auth on all sensitive routes
- Rate limiting on LLM endpoints
- Token budgets to cap cost
- Protected paths (secrets, CI) require confirmation
- Sandbox for edits; promote only after checks pass
- CSP headers in `next.config.ts`
- Debug routes disabled in production
