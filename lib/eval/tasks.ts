/**
 * Eval suite: synthetic tasks for measuring agent quality.
 * Used by GET /api/evaluation/tasks and by scripts/run-eval.
 */

export type EvalTask = {
  id: string;
  label: string;
  instruction: string;
  /** What to check: "sandbox_checks_passed" | "file_touched" | "manual" */
  expectedCheck: "sandbox_checks_passed" | "file_touched" | "manual";
};

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "fix-failing-test",
    label: "Fix failing test",
    instruction:
      "A test is failing with: AssertionError: expected 2 to equal 3. The test is in src/example.test.ts and checks a function add(1,2). Fix the implementation so the test passes.",
    expectedCheck: "sandbox_checks_passed",
  },
  {
    id: "add-endpoint",
    label: "Add API endpoint",
    instruction:
      "Add a new GET /api/health endpoint that returns { status: 'ok' }. Use the existing API route pattern in this project.",
    expectedCheck: "file_touched",
  },
  {
    id: "refactor-function",
    label: "Refactor function",
    instruction:
      "Find the function that calculates the sum of an array of numbers and refactor it to use reduce. Keep the same behavior.",
    expectedCheck: "manual",
  },
  {
    id: "add-tests",
    label: "Add tests",
    instruction:
      "Add unit tests for the utility function that formats a date string. Use the project's test framework.",
    expectedCheck: "sandbox_checks_passed",
  },
];

export function getEvalTask(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((t) => t.id === id);
}
