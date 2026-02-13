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
import { Users, RefreshCw, Sparkles, Pencil } from "lucide-react";
import { ErrorWithAction } from "@/components/error-with-action";
import { suggestRoleAssignments, type SwarmRole } from "@/lib/models/role-suggestion";

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
  const [assignedRoles, setAssignedRoles] = useState<{ modelId: string; role: SwarmRole }[]>([]);
  const [modifyRoles, setModifyRoles] = useState(false);
  const [setAsDefault, setSetAsDefault] = useState(false);
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

  const toggleGroupModel = (id: string) => {
    setGroupModelIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      setAssignedRoles([]);
      return next;
    });
  };

  const handleAutoAssign = () => {
    const selected = allModels.filter((m) => groupModelIds.includes(m.id));
    if (selected.length === 0) return;
    const suggested = suggestRoleAssignments(
      selected.map((m) => ({ id: m.id, label: m.label, modelSlug: m.modelSlug }))
    );
    setAssignedRoles(suggested);
    setModifyRoles(false);
  };

  const handleCreateGroup = async () => {
    if (!groupLabel.trim()) return;
    setGroupError(null);
    setGroupSubmitting(true);
    try {
      const body: { label: string; description?: string; modelIds?: string[]; modelRoles?: { modelId: string; role: string }[] } = {
        label: groupLabel.trim(),
        description: groupDescription.trim() || undefined,
      };
      if (assignedRoles.length > 0) {
        body.modelRoles = assignedRoles;
      } else {
        body.modelIds = groupModelIds;
      }
      const res = await fetch("/api/models/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGroupError(data.error || "Failed to create group");
        return;
      }
      if (setAsDefault && data.id) {
        await fetch("/api/models/default-group", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultModelGroupId: data.id }),
        });
      }
      setGroupLabel("");
      setGroupDescription("");
      setGroupModelIds([]);
      setAssignedRoles([]);
      setSetAsDefault(false);
      onUpdated();
    } finally {
      setGroupSubmitting(false);
    }
  };

  const roleLabels = { planner: "Planner", coder: "Coder", reviewer: "Reviewer" };
  const modelById = new Map(allModels.map((m) => [m.id, m]));

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
              Select models, then click &quot;Auto-assign roles&quot; to let the app pick the best model for each role. You can modify the assignment if needed.
            </p>
            <label className="text-xs font-medium text-muted-foreground block">Models</label>
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
            {groupModelIds.length >= 1 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={handleAutoAssign}
                  >
                    <Sparkles className="h-3 w-3" />
                    Auto-assign roles
                  </Button>
                  {assignedRoles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => setModifyRoles(!modifyRoles)}
                    >
                      <Pencil className="h-3 w-3" />
                      {modifyRoles ? "Done" : "Modify"}
                    </Button>
                  )}
                </div>
                {assignedRoles.length > 0 && (
                  <div className="rounded border border-border bg-muted/30 p-2 space-y-1 text-xs">
                    {(["planner", "coder", "reviewer"] as const).map((role) => {
                      const entry = assignedRoles.find((r) => r.role === role);
                      const model = entry ? modelById.get(entry.modelId) : null;
                      return (
                        <div key={role} className="flex items-center gap-2">
                          <span className="font-medium text-muted-foreground w-16">{roleLabels[role]}:</span>
                          {modifyRoles ? (
                            <select
                              className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
                              value={entry?.modelId ?? ""}
                              onChange={(e) => {
                                const newModelId = e.target.value;
                                if (!newModelId) return;
                                setAssignedRoles((prev) => {
                                  const oldModelId = entry?.modelId;
                                  const otherEntry = prev.find((r) => r.modelId === newModelId && r.role !== role);
                                  return prev.map((r) => {
                                    if (r.role === role) return { modelId: newModelId, role };
                                    if (otherEntry && r.modelId === newModelId) return { modelId: oldModelId ?? r.modelId, role: r.role };
                                    return r;
                                  });
                                });
                              }}
                            >
                              <option value="">—</option>
                              {allModels.filter((m) => groupModelIds.includes(m.id)).map((m) => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                              ))}
                            </select>
                          ) : (
                            <span>{model?.label ?? "—"}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <label className="text-xs font-medium text-muted-foreground block">Group name</label>
            <input
              type="text"
              placeholder="e.g. My swarm"
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
            <label className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={setAsDefault}
                onChange={(e) => setSetAsDefault(e.target.checked)}
              />
              Set as default group (use for Agent)
            </label>
            {groupError && (
              <ErrorWithAction message={groupError} className="text-xs" />
            )}
            <Button
              size="sm"
              onClick={handleCreateGroup}
              disabled={!groupLabel.trim() || groupModelIds.length === 0 || groupSubmitting}
            >
              {groupSubmitting ? "Creating…" : "Create group"}
            </Button>
            {groupModelIds.length > 0 && assignedRoles.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Tip: Click &quot;Auto-assign roles&quot; to let the app pick the best model for planning vs coding.
              </p>
            )}
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
