"use client";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

const LANG_MAP: Record<string, string> = {
  javascript: "javascript", typescript: "typescript", json: "json", html: "html",
  css: "css", python: "python", go: "go", java: "java", csharp: "csharp",
  c: "c", cpp: "cpp", yaml: "yaml", xml: "xml", markdown: "markdown",
  rust: "rust", ruby: "ruby", kotlin: "kotlin", swift: "swift",
  shell: "shell", powershell: "powershell", sql: "sql", plaintext: "plaintext",
};

function getMonacoLanguage(lang: string): string {
  return LANG_MAP[lang] ?? "plaintext";
}

export type BeautifyDiffDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalContent: string;
  formattedContent: string;
  formatterUsed: string;
  filename: string;
  language: string;
  onApply: () => void;
  onDownload: () => void;
  onCancel: () => void;
};

export function BeautifyDiffDialog({
  open,
  onOpenChange,
  originalContent,
  formattedContent,
  formatterUsed,
  filename,
  language,
  onApply,
  onDownload,
  onCancel,
}: BeautifyDiffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl flex flex-col gap-4">
        <DialogHeader className="shrink-0">
          <DialogTitle>Preview: {filename}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Formatted using {formatterUsed}. Review changes before applying.
          </p>
        </DialogHeader>
        <div className="min-h-[400px] h-[60vh] shrink-0 overflow-hidden rounded border border-border bg-[#1e1e1e]">
          <MonacoDiffEditor
            height="100%"
            language={getMonacoLanguage(language)}
            original={originalContent ?? ""}
            modified={formattedContent ?? ""}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: true },
              lineNumbers: "on",
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onCancel(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => { onDownload(); onOpenChange(false); }}>
            Download Formatted File
          </Button>
          <Button onClick={() => { onApply(); onOpenChange(false); }}>
            Apply Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
