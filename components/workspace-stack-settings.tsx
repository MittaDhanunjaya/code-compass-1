"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileCode, FolderOpen } from "lucide-react";
import type { CodeCompassConfig, CodeCompassServiceConfig, CodeCompassStack } from "@/lib/config/code-compass-config";
import { CODE_COMPASS_CONFIG_PATH } from "@/lib/config/code-compass-config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditor } from "@/lib/editor-context";

const STACK_OPTIONS: CodeCompassStack[] = ["nextjs", "node", "python", "go", "java", "rust"];

type StackConfigResponse =
  | { source: "file"; config: CodeCompassConfig }
  | { source: "auto"; config: CodeCompassConfig }
  | { source: "file"; errors: string[] };

export function WorkspaceStackSettings({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { openFile, setActiveTab } = useEditor();
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"file" | "auto">("auto");
  const [config, setConfig] = useState<CodeCompassConfig | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [form, setForm] = useState<CodeCompassServiceConfig>({
    name: "default",
    root: ".",
    stack: "node",
    lintCommand: "",
    testCommand: "",
    runCommand: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setErrors([]);
    fetch(`/api/workspaces/${workspaceId}/stack-config`)
      .then((r) => r.json())
      .then((data: StackConfigResponse) => {
        if ("errors" in data && data.source === "file") {
          setErrors(data.errors);
          setConfig(null);
          setSource("file");
        } else if ("config" in data) {
          setConfig(data.config);
          setSource(data.source);
          setErrors([]);
          if (data.config.services.length > 0) {
            setForm({ ...data.config.services[0] });
          }
        }
      })
      .catch(() => setErrors(["Failed to load stack config"]))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleOpenConfigFile = useCallback(() => {
    fetch(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(CODE_COMPASS_CONFIG_PATH)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((fileData: { content?: string } | null) => {
        if (!fileData?.content) return;
        openFile(CODE_COMPASS_CONFIG_PATH, fileData.content);
        setActiveTab(CODE_COMPASS_CONFIG_PATH);
        router.push(`/app/${workspaceId}`);
      })
      .catch(() => {});
  }, [workspaceId, openFile, setActiveTab, router]);

  const handleSave = useCallback(() => {
    const toSave: CodeCompassConfig = { services: [{ ...form }] };
    if (!form.name.trim()) {
      setSaveError("Name is required");
      return;
    }
    if (!form.root.trim()) {
      setSaveError("Root is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    fetch(`/api/workspaces/${workspaceId}/stack-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: toSave }),
    })
      .then((r) => r.json())
      .then((data: { ok?: boolean; error?: string; errors?: string[] }) => {
        if (data.ok) {
          setSource("file");
          setConfig(toSave);
        } else {
          setSaveError(data.error ?? data.errors?.join(", ") ?? "Save failed");
        }
      })
      .catch(() => setSaveError("Request failed"))
      .finally(() => setSaving(false));
  }, [workspaceId, form]);

  if (loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading stack config…
      </div>
    );
  }

  if (errors.length > 0 && !config) {
    return (
      <div className="space-y-3 p-4">
        <p className="text-sm font-medium text-destructive">Invalid config</p>
        <ul className="list-inside list-disc text-sm text-muted-foreground">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <Button variant="outline" size="sm" onClick={handleOpenConfigFile}>
          <FileCode className="mr-2 h-4 w-4" />
          Open .code-compass/config.json
        </Button>
      </div>
    );
  }

  if (source === "file" && config) {
    const svc = config.services[0];
    return (
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          Config is coming from <code className="rounded bg-muted px-1">{CODE_COMPASS_CONFIG_PATH}</code> in your repo. Edit that file to change it.
        </p>
        <div className="rounded-lg border border-border bg-muted/20 p-3 text-sm">
          <p><strong>Service:</strong> {svc?.name ?? "—"}</p>
          <p><strong>Root:</strong> {svc?.root ?? "—"}</p>
          <p><strong>Stack:</strong> {svc?.stack ?? "—"}</p>
          {svc?.lintCommand && <p><strong>Lint:</strong> {svc.lintCommand}</p>}
          {svc?.testCommand && <p><strong>Test:</strong> {svc.testCommand}</p>}
          {svc?.runCommand && <p><strong>Run:</strong> {svc.runCommand}</p>}
        </div>
        <Button variant="outline" size="sm" onClick={handleOpenConfigFile}>
          <FolderOpen className="mr-2 h-4 w-4" />
          Open .code-compass/config.json
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">
        No <code className="rounded bg-muted px-1">{CODE_COMPASS_CONFIG_PATH}</code> found. Configure lint, test, and run commands for this workspace (used by sandbox and CI).
      </p>
      <div className="grid gap-3">
        <div>
          <Label htmlFor="stack-name">Service name</Label>
          <Input
            id="stack-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. web-app"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="stack-root">Root</Label>
          <Input
            id="stack-root"
            value={form.root}
            onChange={(e) => setForm((f) => ({ ...f, root: e.target.value }))}
            placeholder=". or apps/web"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="stack-type">Stack</Label>
          <select
            id="stack-type"
            value={form.stack}
            onChange={(e) => setForm((f) => ({ ...f, stack: e.target.value as CodeCompassStack }))}
            className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          >
            {STACK_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="stack-lint">Lint command (optional)</Label>
          <Input
            id="stack-lint"
            value={form.lintCommand ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, lintCommand: e.target.value || undefined }))}
            placeholder="pnpm lint:web"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="stack-test">Test command (optional)</Label>
          <Input
            id="stack-test"
            value={form.testCommand ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, testCommand: e.target.value || undefined }))}
            placeholder="pnpm test:web"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="stack-run">Run command (optional)</Label>
          <Input
            id="stack-run"
            value={form.runCommand ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, runCommand: e.target.value || undefined }))}
            placeholder="pnpm dev:web"
            className="mt-1"
          />
        </div>
      </div>
      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save as .code-compass/config.json"}
      </Button>
    </div>
  );
}
