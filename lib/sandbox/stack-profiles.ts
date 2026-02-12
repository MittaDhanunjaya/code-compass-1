/**
 * Language-specific stack profiles: how to run, test, typical error patterns,
 * and debug prompts for Node/Next.js, Python (Django/FastAPI), Java (Maven/Spring), Go.
 * Used by sandbox checks and by the agent for better error handling and prompts.
 */

import type { StackKind } from "./stack-commands";

export type StackProfile = {
  stack: StackKind;
  label: string;
  /** Commands to try to run the app (first success wins in sandbox). */
  runCommands: Array<{ cmd: string; isServer: boolean; label?: string }>;
  /** Commands to run tests. */
  testCommands: string[];
  /** Commands to run lint. */
  lintCommands: string[];
  /** Regex or substring patterns that indicate a known error type (for classification). */
  errorPatterns: Array<{
    pattern: string | RegExp;
    name: string;
    hint: string;
  }>;
  /** Prompt snippets to prepend when asking the agent to fix errors in this stack. */
  debugPromptHints: string[];
};

const NODE_NEXT: StackProfile = {
  stack: "node",
  label: "Node.js / Next.js",
  runCommands: [
    { cmd: "npm run dev", isServer: true, label: "Next/React dev" },
    { cmd: "npm run start", isServer: true, label: "Production start" },
    { cmd: "npm run serve", isServer: true },
    { cmd: "node server.js", isServer: true },
    { cmd: "node index.js", isServer: true },
    { cmd: "node src/index.js", isServer: true },
  ],
  testCommands: ["npm run test:unit", "npm run test", "npm run test:ci", "npm test", "yarn test", "pnpm test"],
  lintCommands: ["npm run lint", "npm run lint:fix", "npm run lint:check", "eslint .", "npm run check"],
  errorPatterns: [
    { pattern: /EADDRINUSE|port.*already in use|address already in use/i, name: "Port in use", hint: "Change PORT or stop the process using the port" },
    { pattern: /Cannot find module|Module not found|Cannot resolve/i, name: "Module not found", hint: "Install dependency or fix import path" },
    { pattern: /Unexpected token|SyntaxError|Parsing error/i, name: "Syntax error", hint: "Check brackets, commas, and JS/TS syntax" },
    { pattern: /ReferenceError|is not defined/i, name: "Reference error", hint: "Variable/function used before declaration or typo" },
    { pattern: /TypeError.*undefined|null/i, name: "Type error", hint: "Check optional chaining and null checks" },
    { pattern: /ECONNREFUSED|ENOTFOUND|fetch failed/i, name: "Network error", hint: "Backend not running or wrong URL" },
    { pattern: /hydration|did not match/i, name: "Hydration mismatch", hint: "Server/client HTML mismatch in React" },
  ],
  debugPromptHints: [
    "This is a Node.js or Next.js project. Prefer npm/yarn scripts from package.json.",
    "For port conflicts use process.env.PORT or a different port; do not only update README.",
    "For module not found: suggest the exact npm install command and correct import path.",
  ],
};

const PYTHON: StackProfile = {
  stack: "python",
  label: "Python (Django / FastAPI)",
  runCommands: [
    { cmd: "uvicorn main:app --host 0.0.0.0", isServer: true, label: "FastAPI" },
    { cmd: "uvicorn app.main:app --host 0.0.0.0", isServer: true },
    { cmd: "python manage.py runserver", isServer: true, label: "Django" },
    { cmd: "python -m flask run", isServer: true, label: "Flask" },
    { cmd: "python main.py", isServer: true },
    { cmd: "python app.py", isServer: true },
    { cmd: "python -m uvicorn main:app", isServer: true },
  ],
  testCommands: ["pytest", "python -m pytest", "pytest test/", "python -m pytest test/", "python manage.py test"],
  lintCommands: ["ruff check .", "pylint .", "flake8 .", "mypy .", "black --check ."],
  errorPatterns: [
    { pattern: /ModuleNotFoundError|ImportError.*No module named/i, name: "Import error", hint: "Install package (pip/uv) or fix PYTHONPATH" },
    { pattern: /IndentationError|unexpected indent/i, name: "Indentation error", hint: "Use consistent 4 spaces" },
    { pattern: /SyntaxError|invalid syntax/i, name: "Syntax error", hint: "Check colons, parentheses, and string quotes" },
    { pattern: /AttributeError.*has no attribute|'NoneType' object/i, name: "Attribute error", hint: "Check object is not None before access" },
    { pattern: /KeyError|KeyError:/i, name: "Key error", hint: "Key missing in dict; use .get() or check key" },
    { pattern: /TypeError:.*takes.*positional argument/i, name: "Type error", hint: "Wrong number or type of arguments" },
    { pattern: /AssertionError|AssertionError:/i, name: "Assertion error", hint: "Test or assert condition failed" },
    { pattern: /FileNotFoundError|No such file or directory/i, name: "File not found", hint: "Path or cwd incorrect" },
  ],
  debugPromptHints: [
    "This is a Python project (Django/FastAPI/Flask). Use venv if present (venv/bin/python or .venv).",
    "For ImportError suggest the exact pip/uv install and correct import path.",
    "For Django: check INSTALLED_APPS, migrations, and manage.py.",
  ],
};

const JAVA: StackProfile = {
  stack: "java",
  label: "Java (Maven / Spring)",
  runCommands: [
    { cmd: "mvn spring-boot:run", isServer: true, label: "Spring Boot" },
    { cmd: "mvn compile exec:java", isServer: true },
    { cmd: "mvn clean install && java -jar target/*.jar", isServer: true },
    { cmd: "./mvnw spring-boot:run", isServer: true },
    { cmd: "./gradlew bootRun", isServer: true, label: "Gradle Spring" },
    { cmd: "./gradlew run", isServer: true },
  ],
  testCommands: ["mvn test", "mvn -q test", "./mvnw test", "./gradlew test", "./gradlew check"],
  lintCommands: ["mvn checkstyle:check", "mvn validate", "mvn compile", "./gradlew checkStyle"],
  errorPatterns: [
    { pattern: /ClassNotFoundException|NoClassDefFoundError/i, name: "Class not found", hint: "Add dependency in pom.xml/build.gradle or fix classpath" },
    { pattern: /NoSuchBeanDefinitionException|required a bean/i, name: "Spring bean error", hint: "Define bean or enable component scan" },
    { pattern: /NullPointerException|NPE/i, name: "Null pointer", hint: "Add null check or use Optional" },
    { pattern: /IllegalArgumentException|IllegalStateException/i, name: "Illegal argument/state", hint: "Check method arguments and state" },
    { pattern: /compilation failed|cannot find symbol/i, name: "Compilation error", hint: "Fix import or type" },
    { pattern: /Port.*already in use|Address already in use/i, name: "Port in use", hint: "Set server.port or stop other process" },
  ],
  debugPromptHints: [
    "This is a Java/Maven or Gradle project. Prefer Maven/Gradle commands.",
    "For Spring: check @ComponentScan, @Configuration, and application.properties.",
    "For ClassNotFoundException add the dependency to pom.xml or build.gradle.",
  ],
};

const GO: StackProfile = {
  stack: "go",
  label: "Go",
  runCommands: [
    { cmd: "go run .", isServer: true },
    { cmd: "go run main.go", isServer: true },
    { cmd: "go run ./cmd/server", isServer: true },
    { cmd: "go build -o app . && ./app", isServer: true },
  ],
  testCommands: ["go test ./...", "go test ./... -v", "go test -short ./..."],
  lintCommands: ["go vet ./...", "golangci-lint run", "staticcheck ./..."],
  errorPatterns: [
    { pattern: /undefined:.*|undefined.*not declared/i, name: "Undefined symbol", hint: "Declare or import the symbol" },
    { pattern: /cannot use.*as.*in argument|type mismatch/i, name: "Type mismatch", hint: "Fix type or convert" },
    { pattern: /nil pointer dereference|panic: runtime error/i, name: "Nil pointer", hint: "Check for nil before dereference" },
    { pattern: /no required module provides package|cannot find package/i, name: "Package not found", hint: "Run go mod tidy or fix import path" },
    { pattern: /listen tcp.*address already in use/i, name: "Port in use", hint: "Change port or stop process" },
  ],
  debugPromptHints: [
    "This is a Go project. Use go run, go build, go test. Modules: go mod tidy.",
    "For undefined: add the import or define the symbol in the right package.",
  ],
};

const DOTNET: StackProfile = {
  stack: "dotnet",
  label: "C# / .NET",
  runCommands: [
    { cmd: "dotnet run", isServer: true, label: "Run" },
    { cmd: "dotnet run --project src/MyApp", isServer: true },
    { cmd: "dotnet watch run", isServer: true },
  ],
  testCommands: ["dotnet test", "dotnet test --no-build", "dotnet test --verbosity normal"],
  lintCommands: ["dotnet format --verify-no-changes", "dotnet build --no-restore"],
  errorPatterns: [
    { pattern: /CS0246|The type or namespace name.*could not be found/i, name: "Type not found", hint: "Add package reference or using" },
    { pattern: /CS1061.*does not contain a definition for/i, name: "Member not found", hint: "Check type and method/property name" },
    { pattern: /NullReferenceException|Object reference not set/i, name: "Null reference", hint: "Add null check or use null-conditional" },
    { pattern: /CS0163|Not all code paths return a value/i, name: "Not all paths return", hint: "Return in all branches" },
    { pattern: /Port.*already in use|address already in use/i, name: "Port in use", hint: "Change applicationUrl or stop process" },
  ],
  debugPromptHints: [
    "This is a C# / .NET project. Use dotnet run, dotnet test, dotnet build.",
    "For missing types add the NuGet package or correct namespace.",
    "For ASP.NET Core check launchSettings.json and Program.cs.",
  ],
};

export const STACK_PROFILES: Record<Exclude<StackKind, "unknown">, StackProfile> = {
  node: NODE_NEXT,
  python: PYTHON,
  go: GO,
  java: JAVA,
  dotnet: DOTNET,
  rust: {
    stack: "rust",
    label: "Rust",
    runCommands: [
      { cmd: "cargo run", isServer: true },
      { cmd: "cargo run --release", isServer: true },
    ],
    testCommands: ["cargo test", "cargo test --no-fail-fast"],
    lintCommands: ["cargo clippy --no-deps", "cargo check"],
    errorPatterns: [
      { pattern: /cannot find (type|fn|struct)|not found in this scope/i, name: "Not found", hint: "Import or define the item" },
      { pattern: /mismatched types|expected.*found/i, name: "Type mismatch", hint: "Fix type or use into()/as" },
      { pattern: /borrow checker|cannot borrow.*as mutable/i, name: "Borrow error", hint: "Satisfy borrow checker" },
    ],
    debugPromptHints: ["This is a Rust project. Use cargo run, cargo test, cargo clippy."],
  },
};

export function getStackProfile(stack: StackKind): StackProfile | null {
  if (stack === "unknown") return null;
  return STACK_PROFILES[stack] ?? null;
}

/** Format diagnostics for use in agent "fix diagnostics" prompt. */
export function formatDiagnosticsForPrompt(diagnostics: Array<{ line: number; column?: number; message: string; severity?: string }>): string {
  return diagnostics
    .map((d) => `Line ${d.line}${d.column != null ? `:${d.column}` : ""} (${d.severity ?? "error"}): ${d.message}`)
    .join("\n");
}

/** Get debug prompt hints for a stack to prepend to agent instructions. */
export function getDebugPromptHintsForStack(stack: StackKind): string {
  const profile = getStackProfile(stack);
  if (!profile || profile.debugPromptHints.length === 0) return "";
  return "Stack-specific hints:\n" + profile.debugPromptHints.map((h) => `- ${h}`).join("\n") + "\n\n";
}
