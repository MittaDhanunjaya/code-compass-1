/**
 * Language-aware code formatters. No LLM - deterministic only.
 * Supports: JS, TS, JSON, HTML, CSS, YAML, Python, Go, Java, C#, C, C++, and more.
 *
 * Design note (offline build): Ship with Prettier only. Python/Go/Java/etc. use
 * system formatters (black, gofmt, etc.) which may not be installed. Offline
 * build should bundle Prettier for JS/TS/JSON/CSS; other languages fall back to
 * basic whitespace normalization when formatter is not installed.
 */

export type FormatResult = {
  formattedCode: string;
  formatterUsed: string;
  diagnostics: string[];
  language: string;
};

export type FormatError = {
  error: string;
  formatterUsed?: string;
  diagnostics: string[];
};

const FORMAT_TIMEOUT_MS = 2000;
const MAX_INPUT_SIZE = 500 * 1024; // 500KB

/** Languages supported by Prettier (built-in; no plugins required) */
const PRETTIER_LANGUAGES = new Set([
  "javascript", "typescript", "json", "html", "css", "scss", "sass", "less",
  "yaml", "markdown", "md", "graphql",
]);

/** Basic beautification: normalize whitespace, line endings */
function basicBeautify(code: string): string {
  if (!code || typeof code !== "string") return code;
  let out = code
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
  if (out.trim().length > 0 && !out.endsWith("\n")) out += "\n";
  return out;
}

/** Format using Prettier (JS/TS/JSON/HTML/CSS/YAML/etc.) */
async function formatWithPrettier(
  code: string,
  language: string
): Promise<{ formatted: string; parser?: string }> {
  const prettier = await import("prettier");
  const parserMap: Record<string, string> = {
    javascript: "babel", js: "babel",
    typescript: "typescript", ts: "typescript",
    jsx: "babel", tsx: "typescript",
    json: "json", html: "html", css: "css",
    scss: "scss", sass: "scss", less: "less",
    yaml: "yaml", yml: "yaml",
    markdown: "markdown", md: "markdown",
    graphql: "graphql",
  };
  const parser = parserMap[language.toLowerCase()] ?? "babel";
  const formatted = await prettier.format(code, {
    parser: parser as "babel",
    printWidth: 100,
  });
  return { formatted, parser };
}

/** Run a formatter command: write to temp file, run (no shell), read result */
async function runFormatterCommand(
  code: string,
  ext: string,
  command: string,
  args: string[],
  readFrom: "file" | "stdout"
): Promise<string> {
  const { spawn } = await import("child_process");
  const { mkdtemp, writeFile, readFile, rm } = await import("fs/promises");
  const { join } = await import("path");
  const { tmpdir } = await import("os");

  const tmpDir = await mkdtemp(join(tmpdir(), "beautify-"));
  const inputPath = join(tmpDir, `input.${ext}`);

  try {
    await writeFile(inputPath, code, "utf-8");

    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: tmpDir,
        stdio: ["ignore", readFrom === "stdout" ? "pipe" : "ignore", "pipe"],
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Formatter timed out"));
      }, FORMAT_TIMEOUT_MS);

      let stdout = "";
      let stderr = "";
      if (proc.stdout) proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", async (exitCode) => {
        clearTimeout(timeout);
        try {
          if (readFrom === "stdout") {
            if (exitCode === 0) resolve(stdout);
            else reject(new Error(stderr || `Exit ${exitCode}`));
          } else {
            const result = await readFile(inputPath, "utf-8");
            if (exitCode === 0) resolve(result);
            else reject(new Error(stderr || `Exit ${exitCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
      proc.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

/** Format Python with black (if available) - reads stdin, writes stdout */
async function formatPython(code: string): Promise<FormatResult> {
  try {
    const { spawn } = await import("child_process");
    const proc = spawn("black", ["-q", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.stdin?.end(code, "utf-8");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Timeout")); }, FORMAT_TIMEOUT_MS);
      proc.on("close", (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(stderr)); });
    });
    return { formattedCode: stdout, formatterUsed: "black", diagnostics: [], language: "python" };
  } catch {
    return {
      formattedCode: basicBeautify(code),
      formatterUsed: "basic",
      diagnostics: ["black not installed; used basic formatting. Install: pip install black"],
      language: "python",
    };
  }
}

/** Format Go with gofmt - in-place -w */
async function formatGo(code: string): Promise<FormatResult> {
  try {
    const formatted = await runFormatterCommand(code, "go", "gofmt", ["-w", "input.go"], "file");
    return { formattedCode: formatted, formatterUsed: "gofmt", diagnostics: [], language: "go" };
  } catch {
    return {
      formattedCode: basicBeautify(code),
      formatterUsed: "basic",
      diagnostics: ["gofmt not installed; used basic formatting"],
      language: "go",
    };
  }
}

/** Format Java with google-java-format (if available) - stdin to stdout */
async function formatJava(code: string): Promise<FormatResult> {
  try {
    const { spawn } = await import("child_process");
    const proc = spawn("google-java-format", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.stdin?.end(code, "utf-8");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("Timeout")); }, FORMAT_TIMEOUT_MS);
      proc.on("close", (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error(stderr)); });
    });
    return { formattedCode: stdout, formatterUsed: "google-java-format", diagnostics: [], language: "java" };
  } catch {
    return {
      formattedCode: basicBeautify(code),
      formatterUsed: "basic",
      diagnostics: ["google-java-format not installed; used basic formatting"],
      language: "java",
    };
  }
}

/** Format C/C++ with clang-format - in-place */
async function formatCpp(code: string, lang: string): Promise<FormatResult> {
  const ext = lang === "c" ? "c" : "cpp";
  try {
    const formatted = await runFormatterCommand(code, ext, "clang-format", ["-style=file", "-i", `input.${ext}`], "file");
    return { formattedCode: formatted, formatterUsed: "clang-format", diagnostics: [], language: lang };
  } catch {
    return {
      formattedCode: basicBeautify(code),
      formatterUsed: "basic",
      diagnostics: ["clang-format not installed; used basic formatting"],
      language: lang,
    };
  }
}

/** Format C# - dotnet format requires a project; use basic beautification */
async function formatCSharp(code: string): Promise<FormatResult> {
  return {
    formattedCode: basicBeautify(code),
    formatterUsed: "basic",
    diagnostics: ["C#: Use Prettier plugin or install dotnet format for full formatting. Applied basic whitespace normalization."],
    language: "csharp",
  };
}

/** Format Rust with rustfmt - in-place */
async function formatRust(code: string): Promise<FormatResult> {
  try {
    const formatted = await runFormatterCommand(code, "rs", "rustfmt", ["input.rs"], "file");
    return { formattedCode: formatted, formatterUsed: "rustfmt", diagnostics: [], language: "rust" };
  } catch {
    return {
      formattedCode: basicBeautify(code),
      formatterUsed: "basic",
      diagnostics: ["rustfmt not installed; used basic formatting"],
      language: "rust",
    };
  }
}

/**
 * Format code by language. Deterministic, no LLM.
 */
export async function formatCode(
  code: string,
  language: string,
  filename?: string
): Promise<FormatResult> {
  if (code.length > MAX_INPUT_SIZE) {
    throw new Error("File too large. Maximum size is 500KB.");
  }

  const lang = language.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Prettier-supported languages
  if (PRETTIER_LANGUAGES.has(lang) || PRETTIER_LANGUAGES.has(language)) {
    try {
      const { formatted, parser } = await formatWithPrettier(code, language);
      return {
        formattedCode: formatted,
        formatterUsed: `prettier (${parser ?? "auto"})`,
        diagnostics: [],
        language,
      };
    } catch (e) {
      return {
        formattedCode: basicBeautify(code),
        formatterUsed: "basic",
        diagnostics: [e instanceof Error ? e.message : "Prettier failed; used basic formatting"],
        language,
      };
    }
  }

  // Language-specific formatters (run in sandbox)
  switch (lang) {
    case "python":
      return formatPython(code);
    case "go":
      return formatGo(code);
    case "java":
      return formatJava(code);
    case "c":
    case "cpp":
      return formatCpp(code, lang);
    case "csharp":
    case "vb":
    case "fsharp":
      return formatCSharp(code);
    case "rust":
      return formatRust(code);
    default:
      return {
        formattedCode: basicBeautify(code),
        formatterUsed: "basic",
        diagnostics: [`No formatter for ${language}; applied basic whitespace normalization`],
        language,
      };
  }
}

/**
 * Prepare LLM edit content for application: escape normalization + deterministic formatting.
 * Tooling vs AI: never use LLMs for formatting. Use Prettier/Black/etc here.
 */
export async function prepareEditContent(content: string, path: string): Promise<string> {
  const { beautifyCode, detectFileType } = await import("@/lib/utils/code-beautifier");
  const normalized = beautifyCode(content, path);
  const language = detectFileType(path);
  try {
    const result = await formatCode(normalized, language, path);
    return result.formattedCode;
  } catch {
    return normalized;
  }
}
