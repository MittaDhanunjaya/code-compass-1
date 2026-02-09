import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

type RouteParams = { params: Promise<{ id: string }> };

const LINT_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx"]);
const PY_EXTENSIONS = new Set(["py"]);
const JSON_EXT = "json";

export type LintDiagnostic = {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning";
  source?: string;
  fix?: { range: { start: number; end: number }; text: string };
};

/**
 * Run ESLint on the given content. Optionally use project config content.
 */
async function runEslint(
  path: string,
  content: string,
  projectConfig?: { content: string; filename: string }
): Promise<LintDiagnostic[]> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!LINT_EXTENSIONS.has(ext)) return [];

  try {
    const { ESLint } = await import("eslint");
    let parser: unknown = undefined;
    try {
      parser = (await import("@typescript-eslint/parser")).default;
    } catch {
      // TS parser not available; ESLint will use default
    }
    const overrideConfig: Record<string, unknown> = {
      languageOptions: {
        ...(parser ? { parser: parser as any } : {}),
        parserOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          ecmaFeatures: { jsx: true },
        },
        globals: {
          React: "readonly",
          JSX: "readonly",
          console: "readonly",
          process: "readonly",
          Buffer: "readonly",
          __dirname: "readonly",
          __filename: "readonly",
          module: "readonly",
          require: "readonly",
          exports: "writable",
        },
      },
      rules: {
        "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        "no-undef": "warn",
      },
    };
    let configFilePath: string | undefined;
    if (projectConfig?.content) {
      const tmpDir = mkdtempSync(join(tmpdir(), "eslint-"));
      configFilePath = join(tmpDir, projectConfig.filename);
      writeFileSync(configFilePath, projectConfig.content, "utf8");
    }
    const eslint = new ESLint({
      overrideConfigFile: configFilePath ?? true,
      overrideConfig: configFilePath ? undefined : overrideConfig,
    });

    const results = await eslint.lintText(content, { filePath: path });
    const diagnostics: LintDiagnostic[] = [];

    for (const result of results) {
      for (const msg of result.messages) {
        if (msg.line == null) continue;
        const fix = msg.fix
          ? {
              range: { start: msg.fix.range[0], end: msg.fix.range[1] },
              text: msg.fix.text,
            }
          : undefined;
        diagnostics.push({
          line: msg.line,
          column: msg.column ?? 1,
          endLine: msg.endLine ?? msg.line,
          endColumn: msg.endColumn ?? msg.column ?? 1,
          message: msg.message ?? "Lint",
          severity: msg.severity === 2 ? "error" : "warning",
          source: msg.ruleId ?? "eslint",
          ...(fix ? { fix } : {}),
        });
      }
    }
    return diagnostics;
  } catch (e) {
    console.error("Lint API error:", e);
    throw e;
  }
}

function runJsonLint(path: string, content: string): LintDiagnostic[] {
  if (!path.toLowerCase().endsWith(".json")) return [];
  try {
    JSON.parse(content);
    return [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid JSON";
    const lineMatch = msg.match(/position (\d+)/);
    const pos = lineMatch ? parseInt(lineMatch[1], 10) : 0;
    let line = 1;
    let column = 1;
    if (pos > 0) {
      const before = content.slice(0, pos);
      line = (before.match(/\n/g) ?? []).length + 1;
      const lastNewline = before.lastIndexOf("\n");
      column = lastNewline === -1 ? pos + 1 : pos - lastNewline;
    }
    return [
      {
        line,
        column,
        message: msg,
        severity: "error",
        source: "json",
      },
    ];
  }
}

async function runPythonLint(path: string, content: string): Promise<LintDiagnostic[]> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!PY_EXTENSIONS.has(ext)) return [];
  try {
    const { spawnSync } = await import("child_process");
    const tmpDir = mkdtempSync(join(tmpdir(), "pyflakes-"));
    const tmpFile = join(tmpDir, "file.py");
    writeFileSync(tmpFile, content, "utf8");
    const out = spawnSync("pyflakes", [tmpFile], { encoding: "utf8", timeout: 5000 });
    if (out.error || out.status === null) return [];
    const stderr = (out.stderr ?? "").trim();
    if (!stderr) return [];
    const diagnostics: LintDiagnostic[] = [];
    for (const lineStr of stderr.split("\n")) {
      const m = lineStr.match(/^(.+):(\d+):(\d+):\s*(.+)$/);
      if (m) {
        diagnostics.push({
          line: parseInt(m[2], 10),
          column: parseInt(m[3], 10),
          message: m[4].trim(),
          severity: "warning",
          source: "pyflakes",
        });
      }
    }
    return diagnostics;
  } catch {
    return [];
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  let body: { path?: string; content?: string; eslintConfig?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const path = (body.path ?? "").trim();
  let content = body.content;

  if (!path) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  if (content === undefined) {
    const { data: file } = await supabase
      .from("workspace_files")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("path", path)
      .single();
    content = (file?.content as string) ?? "";
  }

  const strContent = (content ?? "") as string;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const diagnostics: LintDiagnostic[] = [];

  try {
    if (ext === JSON_EXT) {
      diagnostics.push(...runJsonLint(path, strContent));
    } else if (PY_EXTENSIONS.has(ext)) {
      diagnostics.push(...(await runPythonLint(path, strContent)));
    } else if (LINT_EXTENSIONS.has(ext)) {
      let projectConfig: { content: string; filename: string } | undefined;
      if (body.eslintConfig) {
        projectConfig = { content: body.eslintConfig, filename: ".eslintrc.cjs" };
      } else {
        const configPaths = ["eslint.config.mjs", "eslint.config.js", ".eslintrc.cjs", ".eslintrc.json"];
        for (const configPath of configPaths) {
          const { data: configFile } = await supabase
            .from("workspace_files")
            .select("content")
            .eq("workspace_id", workspaceId)
            .eq("path", configPath)
            .single();
          if (configFile?.content) {
            projectConfig = { content: String(configFile.content), filename: configPath };
            break;
          }
        }
      }
      diagnostics.push(...(await runEslint(path, strContent, projectConfig)));
    }
    return NextResponse.json({ diagnostics });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Lint failed";
    return NextResponse.json(
      { diagnostics: [], error: `Lint failed: ${message}` },
      { status: 200 }
    );
  }
}
