"use client";

import { useState, useCallback, useRef } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { BeautifyDiffDialog } from "@/components/beautify-diff-dialog";
import { useEditor } from "@/lib/editor-context";
import { detectLanguageFromContent } from "@/lib/utils/code-beautifier";

const ACCEPTED_EXTENSIONS = ".py,.js,.ts,.jsx,.tsx,.html,.css,.java,.go,.json,.yaml,.yml,.c,.cpp,.cc,.cxx,.h,.hpp,.cs,.vb,.fs,.xml,.md,.scss,.sass,.less,.sql,.sh,.bash,.ps1,.rb,.rs,.kt,.swift";

const EXT_TO_LANGUAGE: Record<string, string> = {
  py: "python", pyw: "python",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", html: "html", htm: "html", css: "css", scss: "scss", sass: "sass", less: "less",
  java: "java", go: "go",
  c: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "c", hpp: "cpp",
  cs: "csharp", vb: "vb", fs: "fsharp",
  yaml: "yaml", yml: "yaml", xml: "xml", md: "markdown",
  sql: "sql", sh: "shell", bash: "shell", ps1: "powershell",
  rb: "ruby", rs: "rust", kt: "kotlin", swift: "swift",
};

const LANGUAGE_OPTIONS = [
  { value: "plaintext", label: "Plain text" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "json", label: "JSON" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "yaml", label: "YAML" },
  { value: "markdown", label: "Markdown" },
  { value: "go", label: "Go" },
  { value: "java", label: "Java" },
  { value: "csharp", label: "C#" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "rust", label: "Rust" },
  { value: "ruby", label: "Ruby" },
  { value: "xml", label: "XML" },
  { value: "sql", label: "SQL" },
  { value: "shell", label: "Shell" },
];

function detectLanguageFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}

type InputMode = "upload" | "current-file" | "paste";

export type BeautifyCodeButtonProps = {
  /** Compact style for toolbar (icon + short label) */
  variant?: "default" | "compact";
};

export function BeautifyCodeButton({ variant = "default" }: BeautifyCodeButtonProps) {
  const { activeTab, getTab, applyExternalEdits } = useEditor();
  const [open, setOpen] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("current-file");
  const [code, setCode] = useState("");
  const [filename, setFilename] = useState("");
  const [pasteLanguage, setPasteLanguage] = useState("plaintext");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [languageMismatchWarning, setLanguageMismatchWarning] = useState<string | null>(null);
  const [result, setResult] = useState<{
    formattedCode: string;
    formatterUsed: string;
    diagnostics: string[];
    language: string;
  } | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const tab = activeTab ? getTab(activeTab) : undefined;
  const hasCurrentFile = !!tab;
  const hasInput = code.trim().length > 0;

  const resolveCodeAndLanguage = useCallback((): { code: string; filename: string; language: string } | null => {
    if (inputMode === "current-file" && tab) {
      return { code: tab.content, filename: tab.path, language: detectLanguageFromFilename(tab.path) };
    }
    if (inputMode === "upload" || inputMode === "paste") {
      if (!code.trim()) return null;
      return {
        code,
        filename: inputMode === "upload" ? filename : `pasted.${pasteLanguage === "plaintext" ? "txt" : pasteLanguage}`,
        language: inputMode === "upload" ? detectLanguageFromFilename(filename) : pasteLanguage,
      };
    }
    return null;
  }, [inputMode, tab, code, filename, pasteLanguage]);

  const validatePasteLanguage = useCallback((content: string, selectedLang: string) => {
    if (!content.trim() || selectedLang === "plaintext") {
      setLanguageMismatchWarning(null);
      return;
    }
    const detected = detectLanguageFromContent(content);
    if (detected === "plaintext") return;
    const mismatchMap: Record<string, string[]> = {
      python: ["javascript", "typescript", "html", "json", "go", "java", "csharp", "rust"],
      javascript: ["python", "go", "java", "csharp", "rust"],
      typescript: ["python", "go", "java", "csharp", "rust"],
      html: ["python", "javascript", "typescript", "json", "go"],
      json: ["python", "html", "go", "java"],
      go: ["python", "javascript", "typescript", "html", "json"],
      java: ["python", "javascript", "typescript", "html", "go"],
      csharp: ["python", "javascript", "typescript", "html", "go"],
      rust: ["python", "javascript", "typescript", "html", "json"],
    };
    const incompatible = mismatchMap[detected];
    if (incompatible?.includes(selectedLang)) {
      setLanguageMismatchWarning(
        `The pasted content appears to be ${detected}, but you selected ${selectedLang}. Formatting may produce incorrect results.`
      );
    } else {
      setLanguageMismatchWarning(null);
    }
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 500 * 1024) {
      setError("File too large. Maximum size is 500KB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text !== "string") {
        setError("Binary files are not supported.");
        return;
      }
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
        setError("Binary or invalid file content detected.");
        return;
      }
      setCode(text);
      setFilename(file.name);
    };
    reader.readAsText(file, "utf-8");
  }, []);

  const handlePaste = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCode(value);
    setError(null);
    validatePasteLanguage(value, pasteLanguage);
  }, [pasteLanguage, validatePasteLanguage]);

  const handlePasteLanguageChange = useCallback((lang: string) => {
    setPasteLanguage(lang);
    if (code.trim()) validatePasteLanguage(code, lang);
  }, [code, validatePasteLanguage]);

  const handleBeautify = useCallback(async () => {
    const resolved = resolveCodeAndLanguage();
    if (!resolved) return;
    if (languageMismatchWarning && inputMode === "paste") {
      setError("Please fix the language selection mismatch before beautifying.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/tools/beautify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: resolved.code,
          filename: resolved.filename,
          language: resolved.language,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Formatting failed");
      }
      const formatterUsed = data.formatterUsed ?? "basic";
      setResult({
        formattedCode: data.formattedCode ?? data.formatted ?? resolved.code,
        formatterUsed,
        diagnostics: data.diagnostics ?? [],
        language: data.language ?? resolved.language,
      });
      setSuccessMessage(`Code formatted successfully using ${formatterUsed}`);
      if (inputMode === "current-file" && tab) {
        setCode(resolved.code);
        setFilename(resolved.filename);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Formatting failed");
    } finally {
      setLoading(false);
    }
  }, [resolveCodeAndLanguage, languageMismatchWarning, inputMode, tab]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setInputMode("current-file");
    setCode("");
    setFilename("");
    setPasteLanguage("plaintext");
    setError(null);
    setLanguageMismatchWarning(null);
    setResult(null);
    setSuccessMessage(null);
    setLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleApplyFromDiff = useCallback(() => {
    if (!result) return;
    if (inputMode === "current-file" && tab) {
      applyExternalEdits([{ path: tab.path, content: result.formattedCode }]);
    } else {
      setCode(result.formattedCode);
    }
    setResult(null);
  }, [result, inputMode, tab, applyExternalEdits]);

  const canBeautify =
    (inputMode === "current-file" && hasCurrentFile) ||
    (inputMode === "upload" && hasInput) ||
    (inputMode === "paste" && hasInput);

  const buttonEl = (
    <Button
      variant="outline"
      size="sm"
      className={variant === "compact" ? "h-7 gap-1" : "gap-1.5"}
      onClick={() => {
        setOpen(true);
        if (inputMode === "current-file" && tab) {
          setCode(tab.content);
          setFilename(tab.path);
        }
      }}
      title="Format and beautify code (upload, current file, or paste)"
    >
      <Sparkles className="h-3.5 w-3.5" />
      {variant === "compact" ? "Beautify" : "Beautify Code"}
    </Button>
  );

  return (
    <>
      {buttonEl}

      <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Beautify Code</DialogTitle>
            <DialogDescription>
              Choose how to provide code: upload a file, use the current editor file, or paste with an explicit language. Formatting is deterministic (no AI). Works offline.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="flex gap-4">
              <Label className="text-sm font-medium">Input source</Label>
              <div className="flex gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="inputMode"
                    checked={inputMode === "current-file"}
                    onChange={() => {
                      setInputMode("current-file");
                      setError(null);
                      setLanguageMismatchWarning(null);
                      if (tab) {
                        setCode(tab.content);
                        setFilename(tab.path);
                      }
                    }}
                    disabled={!hasCurrentFile}
                  />
                  <span className="text-sm">Current file</span>
                  {!hasCurrentFile && <span className="text-xs text-muted-foreground">(no file open)</span>}
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="inputMode"
                    checked={inputMode === "upload"}
                    onChange={() => {
                      setInputMode("upload");
                      setCode("");
                      setFilename("");
                      setError(null);
                      setLanguageMismatchWarning(null);
                    }}
                  />
                  <span className="text-sm">Upload file</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="inputMode"
                    checked={inputMode === "paste"}
                    onChange={() => {
                      setInputMode("paste");
                      setCode("");
                      setFilename("");
                      setError(null);
                      setLanguageMismatchWarning(null);
                    }}
                  />
                  <span className="text-sm">Paste code</span>
                </label>
              </div>
            </div>

            {inputMode === "upload" && (
              <div>
                <Label className="text-sm font-medium">Upload file</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_EXTENSIONS}
                  onChange={handleFileChange}
                  className="mt-1 block w-full text-sm text-muted-foreground file:mr-4 file:rounded file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
                />
              </div>
            )}

            {inputMode === "paste" && (
              <div className="space-y-2">
                <div>
                  <Label className="text-sm font-medium">Select language (required before paste)</Label>
                  <select
                    value={pasteLanguage}
                    onChange={(e) => handlePasteLanguageChange(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-sm font-medium">Paste code</Label>
                  <Textarea
                    placeholder="Paste your code here..."
                    value={code}
                    onChange={handlePaste}
                    className="mt-1 min-h-[160px] font-mono text-sm"
                    rows={8}
                  />
                </div>
              </div>
            )}

            {inputMode === "current-file" && tab && (
              <div className="rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Using: <span className="font-mono text-foreground">{tab.path}</span>
              </div>
            )}

            {languageMismatchWarning && (
              <div className="rounded border border-amber-500/60 bg-amber-500/15 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                {languageMismatchWarning}
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2">
                <p className="text-sm text-destructive flex-1">{error}</p>
                <Button variant="outline" size="sm" onClick={handleBeautify} disabled={loading}>
                  Retry
                </Button>
              </div>
            )}

            {successMessage && !result && (
              <p className="text-sm text-green-600 dark:text-green-400">{successMessage}</p>
            )}

            {result && result.diagnostics.length > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
                {result.diagnostics.map((d, i) => (
                  <p key={i}>{d}</p>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              onClick={handleBeautify}
              disabled={!canBeautify || loading || !!languageMismatchWarning}
            >
              {loading ? "Formatting…" : "Beautify"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {result && (
        <BeautifyDiffDialog
          open={!!result}
          onOpenChange={(o) => !o && setResult(null)}
          originalContent={inputMode === "current-file" && tab ? tab.content : code}
          formattedContent={result.formattedCode}
          formatterUsed={result.formatterUsed}
          filename={filename || "formatted"}
          language={result.language}
          onApply={() => {
            handleApplyFromDiff();
            setSuccessMessage(`Code formatted successfully using ${result.formatterUsed}`);
          }}
          onDownload={() => {
            const blob = new Blob([result.formattedCode], { type: "text/plain" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = (filename || "formatted").replace(/\.[^.]+$/, "") + "-formatted" + (filename?.includes(".") ? filename.slice(filename.lastIndexOf(".")) : ".txt");
            a.click();
            URL.revokeObjectURL(a.href);
          }}
          onCancel={() => setResult(null)}
        />
      )}
    </>
  );
}
