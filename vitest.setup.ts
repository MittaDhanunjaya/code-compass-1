/**
 * Phase 3.4.2: Vitest setup with MSW.
 * Enables HTTP mocking for LLM APIs before all tests.
 */

import { beforeAll, afterEach, afterAll } from "vitest";
import { server } from "./lib/test/mocks/node";

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
