/**
 * Chain-of-Thought Reasoning: Break down complex problems into steps.
 * Enables multi-step reasoning for complex tasks.
 */

import { getProvider, type ProviderId } from "@/lib/llm/providers";
import type { AgentPlan } from "./types";

export type ReasoningStep = {
  step: number;
  thought: string;
  conclusion: string;
  confidence: "high" | "medium" | "low";
};

export type ChainOfThought = {
  problem: string;
  steps: ReasoningStep[];
  finalPlan: AgentPlan | null;
};

const REASONING_SYSTEM = `You are an expert problem solver. Break down complex problems into logical reasoning steps.

Given a problem or task, think through it step by step:

1. **Understand the problem**: What is being asked? What's the goal?
2. **Analyze the codebase**: What files are involved? What's the current structure?
3. **Identify constraints**: What are the limitations? What must be preserved?
4. **Plan the solution**: What steps are needed? In what order?
5. **Consider edge cases**: What could go wrong? How to handle it?
6. **Verify completeness**: Will this solution work? Is anything missing?

Output your reasoning as a JSON object:
{
  "steps": [
    {
      "step": 1,
      "thought": "What I'm thinking about in this step",
      "conclusion": "What I concluded",
      "confidence": "high|medium|low"
    }
  ],
  "finalPlan": {
    "steps": [
      { "type": "file_edit", "path": "path/to/file", "newContent": "full file content here" },
      { "type": "command", "command": "npm install" }
    ],
    "summary": "Brief summary"
  }
}

CRITICAL: Each entry in finalPlan.steps MUST be an object with:
- For file edits: { "type": "file_edit", "path": "file/path", "newContent": "complete file content" }
- For commands: { "type": "command", "command": "shell command" }
Never use plain text strings in steps—only objects with type, path/newContent, or command.

Think deeply. Don't rush. Consider all aspects of the problem.

Consistency: For the same problem, your finalPlan must always define the same set of deliverables (same file paths and commands). Decide the minimal complete set of steps once; do not vary the list of files or commands between runs.`;

/**
 * Generate chain-of-thought reasoning for a complex problem.
 */
export async function generateChainOfThought(
  problem: string,
  context: string,
  options: {
    apiKey: string;
    providerId: ProviderId;
    model?: string;
  }
): Promise<ChainOfThought> {
  const provider = getProvider(options.providerId);
  
  const userContent = `Problem: ${problem}

Context:
${context}

Think through this problem step by step. Break it down into logical reasoning steps.`;

  const { content } = await provider.chat(
    [
      { role: "system", content: REASONING_SYSTEM },
      { role: "user", content: userContent },
    ],
    options.apiKey,
    { model: options.model, temperature: 0 }
  );

  // Parse JSON response robustly
  const { parseJSONRobust } = await import("../utils/json-parser");
  const parseResult = parseJSONRobust<ChainOfThought>(content, ["steps"]);

  if (!parseResult.success) {
    // Log error but don't throw - return empty reasoning
    const { logError } = await import("../utils/error-handler");
    logError(
      `Chain-of-thought JSON parsing failed: ${parseResult.error}`,
      { category: "parsing", severity: "medium" },
      { raw: parseResult.raw }
    );

    return {
      problem,
      steps: [],
      finalPlan: null,
    };
  }

  return {
    problem,
    steps: parseResult.data?.steps || [],
    finalPlan: parseResult.data?.finalPlan || null,
  };
}

/**
 * Multi-step reasoning: Break down complex problems and reason through them.
 */
export async function multiStepReasoning(
  problem: string,
  context: string,
  options: {
    apiKey: string;
    providerId: ProviderId;
    model?: string;
  },
  maxSteps: number = 5
): Promise<{
  reasoning: ChainOfThought;
  plan: AgentPlan | null;
}> {
  // First: Generate chain-of-thought reasoning
  const reasoning = await generateChainOfThought(problem, context, options);

  // If reasoning produced a plan, use it
  if (reasoning.finalPlan) {
    return {
      reasoning,
      plan: reasoning.finalPlan,
    };
  }

  // Otherwise, use the reasoning steps to inform a simpler plan
  // (This would be handled by the calling code)
  return {
    reasoning,
    plan: null,
  };
}
