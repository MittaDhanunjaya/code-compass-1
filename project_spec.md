# Code-Compass — Project Specification  
## A Cursor‑Class AI Coding Editor (Better Than Cursor)

**Status**: New Project (Greenfield)  
**Goal**: Build an AI-first code editor that matches or exceeds Cursor’s capabilities (Chat, Composer, Agent, Tab, indexing, rules, background agents, etc.), but with a **web-based, multi-provider, bring‑your‑own‑key model** and several unique advantages.  

This document is the **single source of truth**.  
If you are an AI or developer reading this, you should be able to implement the complete system (frontend, backend, infra) without additional high-level clarification.

---

## 1. Core Mission & Principles

### 1.1 Mission

Build a **Cursor‑class AI coding environment** that:

- Lets developers **design, build, and evolve large, critical applications** from short, high-level instructions.
- Provides **all major Cursor features**:  
  - AI Chat, Composer, Agent modes[web:211]  
  - Tab autocomplete (multi-line, context-aware)[web:195][web:241]  
  - Codebase indexing with semantic search and symbol graph[web:212]  
  - Inline CMD+K / slash commands  
  - Self-debugging agents that run tests, fix failures, and operate on the codebase.
- Adds **unique advantages**:
  - 100% **web-based**, no binary install.
  - **Bring your own LLM keys** (Gemini, Grok, DeepSeek, OpenAI, Claude, etc.).
  - Embedded **2–3 click signup flows** for free providers.
  - Free-to-use core; monetization can be added later but is not required in this v1 spec.

### 1.2 Design Principles

1. **AI is the core, not an add-on**  
   The agent, Chat, Composer, and Tab are primary. The editor exists to support them.

2. **Big-project first**  
   Must handle monorepos and complex apps, not just “build a weather app”.

3. **User-owned models & costs**  
   Users bring their own keys; we provide harness, UX, guardrails.

4. **Deterministic harness, probabilistic brain**  
   The orchestration (plans, commands, diffs, tests) is deterministic and auditable; LLM calls are pluggable.

5. **Transparency & control**  
   Users see exactly what the agent plans, changes, and executes.

---

## 2. Target Users & Use Cases

### 2.1 Users

- Advanced solo developers building SaaS, CLIs, backends, infra-heavy apps.
- Small teams (2–10 devs) wanting Cursor-like power in a browser, with BYO keys.
- Indie hackers who want a free, powerful AI coding environment.

### 2.2 Primary Use Cases

1. **Greenfield app creation**  
   - “Create a multi-tenant SaaS with Next.js, PostgreSQL, and Supabase auth.”
   - Agent generates scaffolding, sets up auth, basic pages, and tests.

2. **Large feature addition**  
   - “Add subscription billing with Stripe and integrate it into this pricing page.”

3. **Complex refactors**  
   - “Migrate from REST controllers to tRPC.”
   - “Extract this auth logic into a shared library and update all usages.”

4. **Debugging & self-healing**  
   - “Fix this flaky test suite.”
   - Agent runs tests, interprets failures, and attempts auto-fixes.

5. **Code comprehension**  
   - “Explain how user onboarding works.”
   - “Show me all places where we validate JWT tokens.”

---

## 3. High-Level Architecture

### 3.1 Tech Stack

- **Frontend**: Next.js 15 (App Router, TypeScript), Tailwind CSS, shadcn/ui, Monaco Editor.
- **Backend**: Next.js API routes + Supabase (Auth, Postgres, pgvector, Vault), Node runtime.
- **LLM Providers**: Pluggable (Gemini, Grok, DeepSeek via OpenRouter, OpenAI, Anthropic).
- **Indexing**: Tree-sitter for syntax-level symbols + embeddings via pgvector.[web:212][web:237]  

“The layout, proportions, and interaction patterns of the UI should match Cursor as closely as possible: left file tree, central editor, right AI panel with Chat / Composer / Agent tabs, diff views, and inline status indicators, following the look and feel shown in the reference screenshot.”

### 3.2 Core Components

- **Editor Shell**: Monaco editor + file tree + tabs + git status + terminal.
- **AI Panel**:
  - Chat Mode
  - Composer Mode
  - Agent Mode
- **Tab Autocomplete Engine**
- **Codebase Indexer**: Merkle-based incremental indexing + pgvector embeddings.[web:212][web:237]
- **Agent Harness**: Plan, execute, self-debug, rollback.
- **Provider Layer**: User API key management + secure proxy.

---

## 4. Detailed Functional Requirements

### 4.1 Editor & Workspace

1. **Workspaces**
   - Each workspace maps to a project (repo-like).
   - Users can create, rename, delete workspaces.
   - Files stored in DB (for MVP) or FS abstraction.

2. **File Tree & Tabs**
   - Recursive folders, CRUD (new file/folder, rename, delete).
   - Multiple open tabs, dirty indicators, pinning.

3. **Monaco Editor Features**
   - Syntax highlighting for at least TS/JS, Python, Go, Rust.
   - Minimap, line numbers, bracket matching, basic lint squiggles.

4. **Search**
   - Ctrl+P: fuzzy file search.
   - Ctrl+Shift+F: text search across files.

5. **Git Integration (MVP)**
   - Display git status (M/A/D) for files.
   - View diff vs HEAD.
   - Option to push via CLI instructions (full automation optional later).

---

### 4.2 LLM Provider Layer (BYO Keys)

1. **Providers Supported**
   - Gemini (via Google AI Studio).
   - Grok (xAI).
   - DeepSeek Coder (via OpenRouter).
   - OpenAI (GPT series).
   - Anthropic (Claude series).

2. **Key Storage & Security**
   - Store per-user keys in Supabase Vault, AES-256 encrypted.
   - Keys never exposed to frontend; only backend uses them.
   - Simple audit logs: provider, tokens in/out, timestamps.

3. **Embedded Signup Flows**
   - Gemini: Google OAuth → AI Studio key retrieval (2–3 clicks).
   - Grok: X OAuth → $ credits.
   - DeepSeek: OpenRouter signup → free coder model.

4. **API**
   - Single `LLMProvider` interface:
     - `chat(options)` for chat/completion.
     - `stream(options)` for streaming responses.
     - `embeddings(texts[])` for codebase indexing.

---

### 4.3 Codebase Indexing & Intelligence

**Goal**: Match Cursor’s codebase intelligence; semantic search, symbol graph, incremental indexing.[web:212][web:237][web:240]

1. **Parsing & Symbols**
   - Use Tree-sitter for supported languages.
   - Extract functions, classes, methods, imports, exports.
   - Build per-file symbol table and cross-reference map.

2. **Merkle Tree & Incremental Index**
   - Compute hash per file and overall Merkle root.
   - On changes, detect modified files via Merkle diff.
   - Only re-chunk and re-embed changed files.

3. **Embeddings**
   - Chunk code into semantic chunks (e.g., functions, classes).
   - Use user’s OpenAI (or other) embedding model for vectors.
   - Store in pgvector with metadata: workspace, file path, line range.[web:212]

4. **Semantic Search**
   - Support `@codebase "<query>"` in chat.
   - Use vector similarity to return top-k relevant chunks, then fetch content.
   - Use for:
     - Chat answers.
     - Composer target file selection.
     - Agent context building.

5. **API Endpoints**
   - `/api/index/rebuild` – full reindex.
   - `/api/index/update` – incremental on file changes.
   - `/api/search` – semantic search.

---

### 4.4 AI Modes

#### 4.4.1 Chat Mode (Ask)

Equivalent to Cursor Chat, with codebase awareness.[web:214][web:239]

- Panel in right sidebar.
- Features:
  - Free-form Q&A.
  - “Explain this” based on selection or current file.
  - `@codebase` semantic queries.
  - Memory per workspace (short session-level memory, plus persistent “notes” file if needed).
- Context building:
  - Current file, selection, nearby symbols.
  - Top-k relevant chunks from index.
  - Project metadata (framework, deps, etc.).

#### 4.4.2 Composer Mode

Equivalent to Cursor Composer: multi-file edits, refactors, feature additions.[web:214][web:229][web:239]

- Trigger: Shortcut (`Cmd/Ctrl+I`) or context menu.
- Input:
  - Optional selection (scope).
  - Instruction, e.g., “Add input validation to all user-facing endpoints.”
- Flow:
  1. Determine affected files via semantic search + imports graph.
  2. Propose multi-file changes (diff hunks).
  3. Show Composer UI with:
     - File list.
     - Hunk-by-hunk diff.
     - Actions: “Apply All”, “Apply per hunk”, “Reject”.
- Features:
  - “Apply similar” – detect similar patterns in unseen files and suggest changes.
  - Live preview while editing the Composer instruction.
  - Basic conflict detection with current editor state.

#### 4.4.3 Agent Mode

Equivalent to Cursor Agent; executes multi-step tasks including commands and tests.[web:208][web:238][web:236]
“The Agent must be capable of creating an entire new project (scaffolding + core features + tests) from a single high-level natural language instruction, similar to Cursor Agent’s ‘build an app’ workflows.”

“Agent edits and commands must execute in an isolated sandbox workspace first.
Only after tests and checks pass should the final diffs be applied back to the main workspace and committed on the agent branch.”

“Assume the Agent must be able to build whole projects from a single instruction, working in a sandbox first and only then applying changes to the main tree, and the UI should mirror Cursor’s layout as shown in the screenshot.”

- Trigger: Agent tab in AI sidebar.
- Input: High-level instruction, e.g.:
  - “Add email verification on signup.”
  - “Build a full CRUD for projects with tests.”
- Agent Loop:
  1. **Plan generation**: JSON plan with steps, file operations, commands, tests.
  2. **Plan review**: Show plan to user; require approval before execution.
  3. **Execution**:
     - File edits (using same diff engine as Composer).
     - Command execution (npm, yarn, pip, tests) in sandboxed environment.
     - Test running (jest/pytest/other).
  4. **Self-debugging**:
     - Parse errors from test output, build logs, runtime logs.
     - Attempt focused fixes (up to N tries per failure category).
  5. **Completion**:
     - Summary of changes.
     - Git branch `agent-<timestamp>` with full diff.

- Constraints:
  - Max commands per run (configurable by task type).
  - Max wall-clock time.
  - Allowlist of commands.
  - No network or dangerous shell operations.

- State & Recovery:
  - Persist agent state (plan, current step, logs).
  - Support “resume after crash” and “stop gracefully”.

---

### 4.5 Tab Autocomplete

Match Cursor Tab: ultra-fast, multi-line, project-aware suggestions.[web:220][web:224][web:195][web:241]

- Model: Fast coding model (e.g., DeepSeek-coder via OpenRouter, or small OpenAI model).
- Trigger: As user types; suggestion shown as ghost text.
- Requirements:
  - Latency: Target < 500 ms average on typical snippets.
  - Multi-line: Suggest entire blocks / functions, not just next token.
  - Context:
    - Current file around cursor.
    - Recent edit history.
    - Optionally, nearest semantic neighbors from index.
  - Acceptance:
    - Tab/Enter to accept full suggestion.
    - Option to accept word-by-word or line-by-line.
  - Learning:
    - Track accept/reject to adjust prompt style and aggressiveness.

---

### 4.6 Inline CMD+K and Slash Commands

Cursor-like inline actions for power users.[web:214][web:239]

- **CMD/CTRL + K Overlay**:
  - When pressed, show an inline menu at cursor:
    - “Explain this”
    - “Refactor this”
    - “Write tests for this”
    - “Add docs for this function”
  - Use selection (if present) or current symbol.

- **Slash Commands in Chat**:
  - `/test` – run tests relevant to current file.
  - `/fix` – propose fix to last error or test failure.
  - `/docs` – generate or show doc comments.

---

### 4.7 Rules & Project Configuration

Inspired by Cursor rules & project presets.[web:208][web:234]

- `.aiforge-rules` file at workspace root:
  - Defines project conventions and constraints:
    - “Always use TypeScript, never JS.”
    - “Use Tailwind + shadcn for UI.”
    - “Use Zod for validation.”
    - “Service layer pattern for business logic.”
  - AI must:
    - Read and respect rules in all modes (Chat/Composer/Agent/Tab).
    - Explain when it deviates (only if justified and minimal).

---


### 4.8 Self-Debugging & Testing

- Test Integrations:
  - Detect framework from package/config (jest, vitest, pytest, etc.).
  - Run appropriate test command during agent runs.
- Failure Parsing:
  - Extract failing test names, file paths, line numbers, messages.
- Auto-Fix:
  - For common error types (missing imports, type mismatch, wrong expectations):
    - Generate focused fix.
    - Apply diff.
    - Re-run tests (bounded attempts).
- Constraints:
  - Limit fix attempts per failure.
  - Stop and report if stuck.

---

## 5. Non-Functional Requirements

### 5.1 Performance

- Editor: Typing latency indistinguishable from VS Code.
- Tab: < 500 ms average suggestion time for typical completions.
- Codebase indexing:
  - Cold: Acceptable for medium repos (tens of seconds).
  - Warm (incremental): Rescan only changed files; typically < 3 seconds.[web:212][web:237]
- Agent:
  - Simple tasks (e.g. single-page feature) should complete in under a few minutes with high success reliability.

### 5.2 Reliability & Safety

- No destructive commands; enforce allowlist.
- Never edit files outside the workspace.
- Clear, human-readable error messages.
- Logs for every agent step and LLM call (at least metadata and truncated prompts/outputs).

### 5.3 Security

- User API keys:
  - Encrypted at rest, never rendered to frontend.
  - Per-user isolation (no cross-tenant).
  - Revocable at any time.
- Data:
  - Workspace data scoped per user.
  - No training on user code by default.

---

## 6. Gap Closure vs Cursor & “Better Than Cursor” Targets

This project must **match, then exceed** Cursor’s behavior in these areas:

1. **Modes**:
   - Provide Chat, Composer, Agent, Tab, CMD+K/Slash modes equivalent to Cursor’s feature set.[web:214][web:239][web:220]
   - Ensure keyboard shortcuts and UX are familiar to Cursor users.

2. **Codebase Intelligence**:
   - Use Merkle trees + pgvector indexing to provide:
     - Semantic search.
     - Smart context for Chat/Composer/Agent.
     - Project-wide pattern matching and refactoring.[web:212][web:237][web:240]

3. **Autocomplete Quality**:
   - Tab must feel at least as strong as Cursor Tab:
     - Multi-line, context-aware, with auto-imports when possible.[web:195][web:241]

4. **Agent Reliability**:
   - For tasks like “add feature X” or “refactor module Y”, aim for:
     - ≥ 75–80% success rates with minimal manual intervention (similar to public Cursor evaluations).[web:213][web:238][web:236]

5. **Extra Advantages (Beyond Cursor)**:
   - Multi-provider, BYO keys.
   - Embedded free-provider signups.
   - Web-based (no install).
   - Transparent logs and usage metrics visible to users.

---

## 7. Implementation Order (For AI Agents)

When implementing this project, follow this sequence:

1. **Editor Shell + Supabase Auth + Workspace system.**
2. **Provider Layer (Gemini/Grok/DeepSeek/OpenAI) + Secure key storage.**
3. **Chat Mode integrated with codebase context (files + simple index).**
4. **Codebase indexer (Tree-sitter + pgvector + Merkle incremental updates).**
5. **Composer Mode (multi-file edits + diff UI).**
6. **Agent Mode (plan → edit → commands → tests → git branch).**
7. **Tab Autocomplete (fast model + Monaco integration).**
8. **CMD+K Overlay + Slash commands.**
9. **Self-debugging enhancements (error parsing + auto-fixes).**
10. **Rules system (.aiforge-rules) and project conventions.**

At each step, retain and reuse components: the same indexing engine and provider layer should feed Chat, Composer, Agent, and Tab.

---

## 8. Acceptance Criteria

This project is “done” when:

1. A developer can open AIForge in a browser, sign in, connect a free provider (e.g., Gemini), and:
   - Use Tab autocomplete effectively.
   - Ask Chat questions with `@codebase` and get accurate answers about a real codebase.
   - Use Composer to implement a multi-file feature and review/apply diffs.
   - Use Agent to implement a non-trivial feature end-to-end, including tests and self-fixes, with high reliability.

2. The experience feels **on par with or better than Cursor** along:
   - Completeness of modes (Chat/Composer/Agent/Tab/CMD+K).
   - Codebase awareness and indexing speed.
   - Practical accuracy on real-world coding tasks.
   - User control, transparency, and trust.

3. The system remains focused on our **core motto**:  
   > “Bring your keys, build complex apps faster than Cursor, all in the browser.”

---

**END OF `project_spec.md`**  
Any AI consuming this document should strictly adhere to the architecture, feature set, and sequencing above, and should treat “match or exceed Cursor” as a hard requirement, not a nice-to-have.
