/**
 * Composer v1: multi-file edit plan.
 * Reuses Agent FileEditStep shape; no command steps.
 */

import type { FileEditStep } from "@/lib/agent/types";

export type ComposerScope = "current_file" | "current_folder" | "workspace";

export type ComposerPlan = {
  steps: FileEditStep[];
  summary?: string;
};
