/**
 * Classify error logs for agent context. Helps the agent reason over logs
 * and propose minimal, targeted fixes.
 */

export type ErrorClassification =
  | "port_collision"
  | "missing_dependency"
  | "script_missing"
  | "syntax_error"
  | "runtime_exception"
  | "unknown";

const PORT_COLLISION_PATTERNS = [
  /EADDRINUSE/i,
  /address already in use/i,
  /port.*already in use/i,
  /port.*in use/i,
  /listen EADDRINUSE/i,
  /bind: address already in use/i,
];

const MISSING_DEPENDENCY_PATTERNS = [
  /Cannot find module/i,
  /Module not found/i,
  /ModuleNotFoundError/i,
  /import.*failed/i,
  /require.*failed/i,
  /Cannot find package/i,
  /package.*not found/i,
  /No such file or directory.*node_modules/i,
  /npm ERR!.*404/i,
];

const SCRIPT_MISSING_PATTERNS = [
  /Missing script/i,
  /npm run.*script not found/i,
  /script.*does not exist/i,
  /Unknown script/i,
  /"dev" is not defined/i,
  /"start" is not defined/i,
  /"test" is not defined/i,
  /"build" is not defined/i,
];

const SYNTAX_ERROR_PATTERNS = [
  /SyntaxError/i,
  /Unexpected token/i,
  /Unexpected end of/i,
  /Invalid or unexpected token/i,
  /Parsing error/i,
  /SyntaxError.*unexpected/i,
  /invalid syntax/i,
  /IndentationError/i,
];

export function classifyErrorLog(logText: string): ErrorClassification {
  const trimmed = logText.trim();
  if (!trimmed || trimmed.length < 20) return "unknown";

  const lower = trimmed.toLowerCase();

  if (PORT_COLLISION_PATTERNS.some((r) => r.test(trimmed))) return "port_collision";
  if (MISSING_DEPENDENCY_PATTERNS.some((r) => r.test(trimmed))) return "missing_dependency";
  if (SCRIPT_MISSING_PATTERNS.some((r) => r.test(trimmed))) return "script_missing";
  if (SYNTAX_ERROR_PATTERNS.some((r) => r.test(trimmed))) return "syntax_error";

  // Runtime exception: has Error/Exception + stack trace
  const hasError = /(?:Error|Exception|Traceback|Uncaught|Unhandled)/i.test(trimmed);
  const hasStack = /at\s+\S+\s*\(|File\s+["'].*["']\s*,\s*line|#\d+\s+/.test(trimmed);
  if (hasError && (hasStack || trimmed.split(/\r?\n/).length >= 3)) return "runtime_exception";

  return "unknown";
}

export function getClassificationHint(classification: ErrorClassification): string {
  switch (classification) {
    case "port_collision":
      return "Port collision: another process is using the port. Fix: change port (e.g. PORT=3001) or stop the other process.";
    case "missing_dependency":
      return "Missing dependency: a required module/package is not installed. Fix: add to package.json and run npm install, or pip install.";
    case "script_missing":
      return "Script missing: the npm script does not exist in package.json. Fix: add the script to package.json scripts.";
    case "syntax_error":
      return "Syntax error: invalid code. Fix: correct the syntax at the reported file:line.";
    case "runtime_exception":
      return "Runtime exception: error during execution. Fix: address the root cause at the reported location.";
    default:
      return "Unknown error type. Analyze the stack trace and propose a minimal fix.";
  }
}
