"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_KEYS_URL,
  type ProviderId,
} from "@/lib/llm/providers";
import { ErrorWithAction } from "@/components/error-with-action";

export function KeySettingsContent() {
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("openrouter");
  const [configured, setConfigured] = useState<Record<ProviderId, boolean>>({
    openrouter: false,
    openai: false,
    gemini: false,
    perplexity: false,
    ollama: false,
    lmstudio: false,
  });
  const [needsReentry, setNeedsReentry] = useState<Record<ProviderId, boolean>>({
    openrouter: false,
    openai: false,
    gemini: false,
    perplexity: false,
    ollama: false,
    lmstudio: false,
  });
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageText, setUsageText] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all(
      PROVIDERS.map((p) =>
        fetch(`/api/provider-keys?provider=${p}`)
          .then((res) => res.json())
          .then((data) => ({ 
            provider: p, 
            configured: !!data.configured,
            needsReentry: !!data.needsReentry 
          }))
          .catch(() => ({ provider: p, configured: false, needsReentry: false }))
      )
    ).then((results) => {
      const configuredMap: Record<ProviderId, boolean> = {
        openrouter: false,
        openai: false,
        gemini: false,
        perplexity: false,
        ollama: false,
        lmstudio: false,
      };
      const reentryMap: Record<ProviderId, boolean> = {
        openrouter: false,
        openai: false,
        gemini: false,
        perplexity: false,
        ollama: false,
        lmstudio: false,
      };
      for (const { provider, configured, needsReentry } of results) {
        configuredMap[provider as ProviderId] = configured;
        reentryMap[provider as ProviderId] = needsReentry;
      }
      setConfigured(configuredMap);
      setNeedsReentry(reentryMap);
      setApiKey("");
    }).finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setError(null);
    setUsageText(null);
    setSaving(true);
    try {
      const res = await fetch("/api/provider-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey: apiKey.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setConfigured((prev) => ({ ...prev, [selectedProvider]: true }));
      setNeedsReentry((prev) => ({ ...prev, [selectedProvider]: false }));
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setError(null);
    setUsageText(null);
    setSaving(true);
    try {
      const res = await fetch(
        `/api/provider-keys?provider=${selectedProvider}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to remove");
      setConfigured((prev) => ({ ...prev, [selectedProvider]: false }));
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setSaving(false);
    }
  }

  const isConfigured = configured[selectedProvider];

  async function handleCheckUsage() {
    if (!isConfigured) {
      setUsageText("Add an API key first to check usage.");
      return;
    }
    setUsageLoading(true);
    setUsageText(null);
    try {
      const res = await fetch(
        `/api/provider-usage?provider=${selectedProvider}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch usage");
      const detail = data.usage?.detail;
      if (detail) {
        setUsageText(detail as string);
      } else if (data.usage?.supported === false) {
        setUsageText(
          "Usage API not available for this provider; please use the provider dashboard."
        );
      } else {
        setUsageText("Usage fetched, but no details were returned.");
      }
    } catch (e) {
      setUsageText(
        e instanceof Error ? e.message : "Failed to fetch usage information."
      );
    } finally {
      setUsageLoading(false);
    }
  }

  const placeholder =
    selectedProvider === "openrouter"
      ? "sk-or-..."
      : selectedProvider === "openai"
        ? "sk-..."
        : selectedProvider === "gemini"
          ? "AIza..."
          : "pplx-...";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Keys are stored encrypted and never sent to the frontend. Add at least one provider to use Chat, Composer, and Agent.
      </p>
      <div className="flex gap-1 rounded-lg border border-border p-1 flex-wrap">
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setSelectedProvider(p)}
            className={`flex-1 min-w-0 rounded px-2 py-1.5 text-sm font-medium ${
              selectedProvider === p
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {PROVIDER_LABELS[p]}
            {configured[p] && !needsReentry[p] && (
              <span className="ml-1 text-xs text-green-600">✓</span>
            )}
            {needsReentry[p] && (
              <span className="ml-1 text-xs text-amber-600" title="Key needs to be re-entered due to encryption key change">⚠</span>
            )}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3">
          {needsReentry[selectedProvider] && (
            <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                ⚠️ Key needs to be re-entered
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">
                The encryption key has changed. Please re-enter your API key below to re-encrypt it with the current key.
              </p>
            </div>
          )}
          <div>
            <Label htmlFor="api-key">
              {PROVIDER_LABELS[selectedProvider]} API Key
            </Label>
            <div className="flex items-center justify-between gap-2 mt-1">
              <p className="text-xs text-muted-foreground">
                Get a key from{" "}
                <a
                  href={PROVIDER_KEYS_URL[selectedProvider]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {PROVIDER_KEYS_URL[selectedProvider].replace(/^https?:\/\//, "")}
                </a>
              </p>
              {isConfigured && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCheckUsage}
                  disabled={usageLoading}
                  className="h-7 px-3 text-xs font-medium"
                >
                  {usageLoading ? "Checking…" : "Check Usage"}
                </Button>
              )}
            </div>
            {usageText && (
              <div className="rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground mt-2">
                {usageText}
              </div>
            )}
          </div>
          {selectedProvider === "openrouter" && !isConfigured && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Get a free OpenRouter key</span>
                <a
                  href="https://openrouter.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  OpenRouter.ai →
                </a>
              </div>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Sign up or log in to OpenRouter</li>
                <li>Go to &quot;API Keys&quot; and create a key</li>
                <li>Paste the key below</li>
              </ol>
            </div>
          )}
          {isConfigured ? (
            <div className="flex gap-2 flex-wrap">
              <Input
                id="api-key"
                type="password"
                placeholder="Enter new key to replace"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="flex-1 min-w-[200px]"
              />
              <Button
                variant="outline"
                onClick={handleRemove}
                disabled={saving}
              >
                Remove
              </Button>
              {apiKey.trim() && (
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Update Key"}
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Input
                id="api-key"
                type="password"
                placeholder={placeholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Button onClick={handleSave} disabled={saving || !apiKey.trim()}>
                {saving ? "Saving…" : "Save Key"}
              </Button>
            </div>
          )}
        </div>
      )}
      {error && (
        <ErrorWithAction message={error} />
      )}
    </div>
  );
}
