/**
 * Pre-canned "playbooks" – high-level tasks users can run in Agent/Composer.
 * Used in onboarding ("try a playbook") and in the app (quick-start templates).
 */

export type Playbook = {
  id: string;
  title: string;
  description: string;
  /** Instruction sent to the agent when the user runs this playbook. */
  instruction: string;
  /** Optional: which tab to switch to (agent vs composer). */
  tab?: "agent" | "composer";
};

export const PLAYBOOKS: Playbook[] = [
  {
    id: "fix-failing-test",
    title: "Fix this failing test",
    description: "Paste a failing test or error log; the agent will propose a fix and run it in the sandbox.",
    instruction:
      "I have a failing test or error. I'll paste the error output below. Please analyze it, identify the root cause, and propose minimal code changes to fix it. Run any relevant tests after applying the fix.\n\n[Paste your test output or error log here]",
    tab: "agent",
  },
  {
    id: "add-endpoint",
    title: "Add an API endpoint",
    description: "Describe the endpoint (method, path, behavior); the agent will add it to your app.",
    instruction:
      "Add a new API endpoint to this project. I'll describe it:\n\n- Method and path (e.g. GET /api/users)\n- What it should return or do\n- Any query/body params\n\nUse the existing patterns in the codebase (e.g. Next.js API routes, Express routes, or FastAPI).",
    tab: "agent",
  },
  {
    id: "migrate-pages-to-app",
    title: "Migrate from Pages Router to App Router",
    description: "Convert a Next.js pages/ route to the app/ directory (App Router).",
    instruction:
      "Migrate this Next.js project (or a specific page) from the Pages Router (pages/) to the App Router (app/). Preserve behavior and use the existing app/ structure if present. Update imports and any getServerSideProps/getStaticProps to the App Router equivalents (e.g. server components, generateMetadata).",
    tab: "agent",
  },
  {
    id: "add-tests",
    title: "Add tests for this file",
    description: "Generate unit or integration tests for the current file or selection.",
    instruction:
      "Add tests for the current file (or the code I've selected). Use the project's existing test framework (e.g. Jest, Vitest, pytest). Follow existing test patterns in the repo. Cover main behavior and edge cases.",
    tab: "agent",
  },
  {
    id: "refactor-and-docs",
    title: "Refactor and document",
    description: "Refactor the selected code for clarity and add brief documentation.",
    instruction:
      "Refactor the selected code for clarity and maintainability, and add brief documentation (JSDoc, docstrings, or comments). Preserve behavior; don't change the public API unless it improves clarity.",
    tab: "composer",
  },
];

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}
