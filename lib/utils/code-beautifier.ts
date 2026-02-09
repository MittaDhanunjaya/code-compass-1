/**
 * Code beautifier/formatter utility.
 * Converts escaped newlines to actual newlines and formats code.
 */

/**
 * Beautify code content by converting escaped sequences to actual characters
 * and optionally formatting based on file type.
 */
export function beautifyCode(content: string, filePath?: string): string {
  if (!content || typeof content !== "string") {
    return content;
  }

  // Step 1: Convert escaped newlines to actual newlines
  // Handle common escape sequences that LLMs might include in JSON strings
  let beautified = content
    .replace(/\\n/g, "\n")           // \n -> actual newline
    .replace(/\\r/g, "\r")            // \r -> carriage return
    .replace(/\\t/g, "\t")            // \t -> tab
    .replace(/\\r\\n/g, "\r\n")       // \r\n -> Windows line ending
    .replace(/\\"/g, '"')             // \" -> "
    .replace(/\\'/g, "'")             // \' -> '
    .replace(/\\\\/g, "\\");          // \\ -> \ (but preserve actual backslashes)

  // Step 2: Detect and handle double-escaped sequences
  // Sometimes LLMs double-escape: \\n instead of \n
  // We need to be careful here - only fix if it's clearly a mistake
  // Check if there are patterns like \\n that should be \n
  beautified = beautified.replace(/([^\\])\\(\\n)/g, "$1\n"); // \\n -> \n (but not \\\\n)
  beautified = beautified.replace(/([^\\])\\(\\t)/g, "$1\t"); // \\t -> \t
  beautified = beautified.replace(/([^\\])\\(\\r)/g, "$1\r"); // \\r -> \r

  // Step 3: Normalize line endings (optional - can be configured)
  // Convert all line endings to \n for consistency
  beautified = beautified.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Step 4: Remove trailing whitespace from lines (optional cleanup)
  beautified = beautified.split("\n").map(line => line.replace(/\s+$/, "")).join("\n");

  // Step 5: Ensure file ends with a newline if it has content
  if (beautified.trim().length > 0 && !beautified.endsWith("\n")) {
    beautified += "\n";
  }

  return beautified;
}

/**
 * Detect file type from file path/extension.
 */
export function detectFileType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  
  const typeMap: Record<string, string> = {
    // JavaScript/TypeScript
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    mjs: "javascript",
    cjs: "javascript",
    
    // Python
    py: "python",
    pyw: "python",
    
    // Other common languages
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    fish: "shell",
    ps1: "powershell",
    
    // Config files
    toml: "toml",
    ini: "ini",
    env: "env",
  };
  
  return typeMap[ext] || "text";
}

/**
 * Format code using Prettier if available, otherwise use basic beautification.
 */
export async function formatCode(
  content: string,
  filePath?: string
): Promise<string> {
  // First, apply basic beautification (always)
  let formatted = beautifyCode(content, filePath);
  
  // Try to use Prettier if available (optional enhancement)
  // For now, we'll just use the basic beautifier
  // In the future, we could add Prettier integration here
  
  return formatted;
}
