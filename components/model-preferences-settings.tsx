"use client";

import { useState, useEffect } from "react";
import { MessageSquare, Wand2, Zap, Plus } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MODEL_CATALOG,
  MAX_PREFERRED_MODELS,
  type ModelCategory,
} from "@/lib/llm/model-catalog";
import {
  getModelPreferences,
  setModelPreferences,
  togglePreferredModel,
  type ModelPreferences,
} from "@/lib/llm/model-preferences";

const CATEGORY_LABELS: Record<ModelCategory, string> = {
  free: "Free",
  "low-cost": "Low-cost",
  efficient: "Efficient",
  other: "Perplexity & Gemini",
};

const CATEGORY_HINTS: Record<ModelCategory, string> = {
  free: "No cost, good for coding & reasoning",
  "low-cost": "Paid but cheap (~$0.15–0.60/M tokens)",
  efficient: "Fast + quality for coding & planning",
  other: "Perplexity, Gemini – web-augmented & free tier",
};

export function ModelPreferencesSettings() {
  const [prefs, setPrefs] = useState<ModelPreferences | null>(null);
  const [mounted, setMounted] = useState(false);
  const [customModelId, setCustomModelId] = useState("");

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) setPrefs(getModelPreferences());
  }, [mounted]);

  if (!mounted || !prefs) return null;

  const handleToggle = (id: string) => {
    setPrefs(togglePreferredModel(id));
  };

  const handleModeToggle = (key: keyof Pick<ModelPreferences, "showInAgent" | "showInChat" | "showInComposer">) => {
    const next = { ...prefs, [key]: !prefs[key] };
    setModelPreferences(next);
    setPrefs(next);
  };

  const handleAddCustomModel = () => {
    const id = customModelId.trim();
    if (!id || atLimit || prefs.preferredModelIds.includes(id)) return;
    setPrefs(togglePreferredModel(id));
    setCustomModelId("");
  };

  const selectedCount = prefs.preferredModelIds.length;
  const atLimit = selectedCount >= MAX_PREFERRED_MODELS;
  const catalogIds = new Set(MODEL_CATALOG.all.map((m) => m.id));
  const customModelIds = prefs.preferredModelIds.filter((id) => !catalogIds.has(id));

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label className="text-base font-medium">Pick your models (max {MAX_PREFERRED_MODELS})</Label>
        <p className="text-sm text-muted-foreground">
          Select up to {MAX_PREFERRED_MODELS} models. These appear in the model dropdown in Chat, Composer, and Agent when the selector is shown.
        </p>
        <p className="text-xs text-muted-foreground">
          {selectedCount} / {MAX_PREFERRED_MODELS} selected
          {atLimit && " — Deselect one to add another"}
        </p>
      </section>

      <div className="space-y-4">
        {(["free", "other", "low-cost", "efficient"] as const).map((cat) => (
          <div key={cat} className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{CATEGORY_LABELS[cat]}</span>
              <span className="text-xs text-muted-foreground">— {CATEGORY_HINTS[cat]}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {MODEL_CATALOG[cat].map((m) => {
                const isSelected = prefs.preferredModelIds.includes(m.id);
                const canAdd = !isSelected && !atLimit;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleToggle(m.id)}
                    disabled={!isSelected && atLimit}
                    className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : canAdd
                          ? "bg-muted hover:bg-muted/80 text-foreground"
                          : "bg-muted/50 text-muted-foreground cursor-not-allowed"
                    }`}
                  >
                    {isSelected && "✓ "}
                    {m.label}
                    {m.hint && <span className="text-[10px] opacity-80">({m.hint})</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {customModelIds.length > 0 && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <span className="text-sm font-medium">Custom models</span>
          <div className="flex flex-wrap gap-2">
            {customModelIds.map((id) => {
              const isSelected = prefs.preferredModelIds.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleToggle(id)}
                  className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium bg-primary text-primary-foreground"
                >
                  ✓ {id}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border p-3 space-y-2">
        <Label className="text-sm font-medium">Add custom model (non-listed)</Label>
        <p className="text-xs text-muted-foreground">
          For OpenRouter: use <code className="rounded bg-muted px-1">openrouter/provider/model-id</code> (e.g. openrouter/anthropic/claude-sonnet-4). For Perplexity: <code className="rounded bg-muted px-1">perplexity:sonar-pro</code>. Add the provider API key in API Keys tab first.
        </p>
        <div className="flex gap-2">
          <Input
            placeholder="e.g. openrouter/anthropic/claude-sonnet-4"
            value={customModelId}
            onChange={(e) => setCustomModelId(e.target.value)}
            className="flex-1 text-sm font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAddCustomModel}
            disabled={!customModelId.trim() || atLimit || prefs.preferredModelIds.includes(customModelId.trim())}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>
      </div>

      <section className="space-y-2">
        <Label className="text-base font-medium">Show model selector in</Label>
        <p className="text-sm text-muted-foreground">
          Control where the model dropdown appears. When off, the app uses the default model.
        </p>
        <div className="flex flex-wrap gap-4 pt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.showInAgent}
              onChange={() => handleModeToggle("showInAgent")}
              className="rounded border-input"
            />
            <Zap className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Agent</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.showInChat}
              onChange={() => handleModeToggle("showInChat")}
              className="rounded border-input"
            />
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Chat</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={prefs.showInComposer}
              onChange={() => handleModeToggle("showInComposer")}
              className="rounded border-input"
            />
            <Wand2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Composer</span>
          </label>
        </div>
      </section>

      {selectedCount > 0 && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setModelPreferences({ preferredModelIds: [] });
              setPrefs(getModelPreferences());
            }}
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
