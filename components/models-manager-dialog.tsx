"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Users, RefreshCw } from "lucide-react";
import { ErrorWithAction } from "@/components/error-with-action";

interface AvailableModel {
  id: string;
  label: string;
  provider: string;
  modelSlug: string;
  isDefault?: boolean;
  isFree?: boolean;
  hasKey?: boolean | string;
}

interface AvailableGroup {
  id: string;
  label: string;
  description?: string;
}

interface UserModelRow extends AvailableModel {
  modelId: string;
  enabled: boolean;
}

type ModelsAvailable = {
  defaultModels: AvailableModel[];
  userModels: UserModelRow[];
  groups: AvailableGroup[];
} | null;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelsAvailable: ModelsAvailable;
  onUpdated: () => void;
};

export function ModelsManagerDialog({ open, onOpenChange, modelsAvailable, onUpdated }: Props) {
  const [addModelId, setAddModelId] = useState("");
  const [addModelApiKey, setAddModelApiKey] = useState("");
  const [addModelAlias, setAddModelAlias] = useState("");
  const [addModelSubmitting, setAddModelSubmitting] = useState(false);
  const [addModelError, setAddModelError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [groupLabel, setGroupLabel] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupModelIds, setGroupModelIds] = useState<string[]>([]);
  const [groupSubmitting, setGroupSubmitting] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);

  useEffect(() => {
    if (open) onUpdated();
  }, [open, onUpdated]);

  const handleRefresh = () => {
    setLoading(true);
    onUpdated();
    setTimeout(() => setLoading(false), 800);
  };

  const defaultModels = modelsAvailable?.defaultModels ?? [];
  const userModelsNormalized = (modelsAvailable?.userModels ?? []).map((u) => ({ ...u, id: u.modelId }));
  const seenIds = new Set<string>();
  const allModels = [...defaultModels, ...userModelsNormalized].filter((m) => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });

  const handleAddModel = async () => {
    if (!addModelId.trim()) return;
    setAddModelError(null);
    setAddModelSubmitting(true);
    try {
      const res = await fetch("/api/models/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: addModelId,
          apiKey: addModelApiKey.trim() || undefined,
          aliasLabel: addModelAlias.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddModelError(data.error || "Failed to add model");
        return;
      }
      setAddModelId("");
      setAddModelApiKey("");
      setAddModelAlias("");
      onUpdated();
    } finally {
      setAddModelSubmitting(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!groupLabel.trim()) return;
    setGroupError(null);
    setGroupSubmitting(true);
    try {
      const res = await fetch("/api/models/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: groupLabel.trim(),
          description: groupDescription.trim() || undefined,
          modelIds: groupModelIds,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGroupError(data.error || "Failed to create group");
        return;
      }
      setGroupLabel("");
      setGroupDescription("");
      setGroupModelIds([]);
      onUpdated();
    } finally {
      setGroupSubmitting(false);
    }
  };

  const toggleGroupModel = (id: string) => {
    setGroupModelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Models & groups</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 pt-2">
          {/* Add model */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Add model</h4>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleRefresh} disabled={loading}>
                <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Choose a model from the catalog, then optionally add an API key (OpenRouter/Gemini etc. in Settings also works for free models).
            </p>
            <label className="text-xs font-medium text-muted-foreground block">Model from catalog</label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addModelId}
              onChange={(e) => setAddModelId(e.target.value)}
              aria-label="Choose a model"
            >
              <option value="">Choose a model…</option>
              {defaultModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.provider}{m.isFree ? " (free)" : ""}
                </option>
              ))}
            </select>
            {defaultModels.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-md px-2 py-1.5">
                No models in catalog. Run database migrations so default models (Ollama, OpenRouter free) are available. You can still use the Model dropdown above and pick &quot;Free (auto-select)&quot; or &quot;Auto&quot; with an OpenRouter key in Settings.
              </p>
            )}
            <label className="text-xs font-medium text-muted-foreground block">API key (optional for free/default models)</label>
            <input
              type="password"
              placeholder="Paste key if this model needs one"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addModelApiKey}
              onChange={(e) => setAddModelApiKey(e.target.value)}
            />
            <label className="text-xs font-medium text-muted-foreground block">Alias (optional)</label>
            <input
              type="text"
              placeholder="e.g. My DeepSeek"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={addModelAlias}
              onChange={(e) => setAddModelAlias(e.target.value)}
            />
            {addModelError && (
              <ErrorWithAction message={addModelError} className="text-xs" />
            )}
            <Button size="sm" onClick={handleAddModel} disabled={!addModelId.trim() || addModelSubmitting}>
              {addModelSubmitting ? "Adding…" : "Add model"}
            </Button>
          </div>

          {/* Create group */}
          <div className="space-y-2 border-t pt-4">
            <h4 className="text-sm font-medium flex items-center gap-1">
              <Users className="h-4 w-4" /> Create group
            </h4>
            <p className="text-xs text-muted-foreground">
              Combine models into a group: 1st = planner, 2nd = coder, 3rd = reviewer. Select models below in the order you want.
            </p>
            <label className="text-xs font-medium text-muted-foreground block">Group name</label>
            <input
              type="text"
              placeholder="e.g. Planner + Coder"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
            />
            <label className="text-xs font-medium text-muted-foreground block">Description (optional)</label>
            <Textarea
              placeholder="When to use this group"
              className="min-h-[60px] text-sm"
              value={groupDescription}
              onChange={(e) => setGroupDescription(e.target.value)}
            />
            <label className="text-xs font-medium text-muted-foreground block">Models in order (planner → coder → reviewer)</label>
            <div className="max-h-40 overflow-y-auto rounded border border-input p-2 space-y-1">
              {allModels.map((m) => (
                <label key={m.id} className="flex items-center gap-2 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={groupModelIds.includes(m.id)}
                    onChange={() => toggleGroupModel(m.id)}
                  />
                  <span>{m.label}</span>
                  {m.isFree && <span className="text-[10px] text-green-600 dark:text-green-400">(free)</span>}
                </label>
              ))}
              {allModels.length === 0 && (
                <p className="text-xs text-muted-foreground py-1">
                  No models available yet. Add models above first, or run database migrations to load default models (Ollama, OpenRouter free).
                </p>
              )}
            </div>
            {groupError && (
              <ErrorWithAction message={groupError} className="text-xs" />
            )}
            <Button size="sm" onClick={handleCreateGroup} disabled={!groupLabel.trim() || groupSubmitting}>
              {groupSubmitting ? "Creating…" : "Create group"}
            </Button>
          </div>

          {modelsAvailable?.groups?.length ? (
            <div className="border-t pt-4">
              <h4 className="text-sm font-medium text-muted-foreground mb-1">Your groups</h4>
              <ul className="text-xs space-y-0.5">
                {modelsAvailable.groups.map((g) => (
                  <li key={g.id}>{g.label}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
