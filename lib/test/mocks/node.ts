/**
 * Phase 3.4.2: MSW server for Node.js (Vitest).
 * Intercepts HTTP requests to LLM APIs (OpenAI, OpenRouter).
 */

import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
