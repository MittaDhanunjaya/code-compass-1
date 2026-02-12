"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Github, Key, Keyboard, Settings, Shield, User } from "lucide-react";
import { DEFAULT_PROTECTED_PATTERNS } from "@/lib/protected-paths";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeySettingsContent } from "@/components/key-settings-content";

type SettingsTab = "general" | "keys" | "safety" | "shortcuts" | "github";

type GitHubStatus = {
  linked: boolean;
  username: string | null;
  avatarUrl: string | null;
};

type GitHubOAuthConfig = {
  configured: boolean;
  clientIdMasked: string | null;
};

function SettingsContent() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [oauthConfig, setOauthConfig] = useState<GitHubOAuthConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      fetch("/api/user/github").then((r) => r.json()),
      fetch("/api/settings/github-oauth").then((r) => r.json()),
    ])
      .then(([userData, oauthData]) => {
        if (!mounted) return;
        if (userData.linked === true && userData.username != null) {
          setStatus({
            linked: true,
            username: userData.username,
            avatarUrl: userData.avatarUrl ?? null,
          });
        } else {
          setStatus({ linked: false, username: null, avatarUrl: null });
        }
        if (oauthData.configured != null) {
          setOauthConfig({
            configured: oauthData.configured,
            clientIdMasked: oauthData.clientIdMasked ?? null,
          });
        }
      })
      .catch(() => {
        if (mounted) setStatus({ linked: false, username: null, avatarUrl: null });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  // Switch tab from URL: ?tab=keys or ?tab=safety or ?github=...
  useEffect(() => {
    const tab = searchParams.get("tab");
    const github = searchParams.get("github");
    if (tab === "keys") setActiveTab("keys");
    else if (tab === "safety") setActiveTab("safety");
    else if (tab === "shortcuts") setActiveTab("shortcuts");
    else if (tab === "github" || github) setActiveTab("github");
  }, [searchParams]);

  useEffect(() => {
    const github = searchParams.get("github");
    const msg = searchParams.get("message");
    if (github === "connected") setMessage("GitHub connected successfully.");
    if (github === "error") {
      if (msg === "not_configured") {
        setMessage(
          "GitHub OAuth is not configured. Set Client ID and Secret below (or add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env.local)."
        );
      } else {
        setMessage(msg ? `Error: ${msg}` : "GitHub connection failed.");
      }
    }
  }, [searchParams]);

  async function handleSaveOAuthConfig() {
    setOauthSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/github-oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: oauthClientId.trim() || undefined,
          clientSecret: oauthClientSecret.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      setOauthConfig({
        configured: !!data.configured,
        clientIdMasked: data.clientIdMasked ?? null,
      });
      setOauthClientId("");
      setOauthClientSecret("");
      setMessage(data.configured ? "GitHub OAuth credentials saved." : "GitHub OAuth credentials cleared.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setOauthSaving(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/user/github/disconnect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to disconnect");
      setStatus({ linked: false, username: null, avatarUrl: null });
      setMessage("GitHub disconnected.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        Loading…
      </div>
    );
  }

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: "General", icon: <User className="h-4 w-4" /> },
    { id: "keys", label: "API Keys", icon: <Key className="h-4 w-4" /> },
    { id: "safety", label: "Safety", icon: <Shield className="h-4 w-4" /> },
    { id: "shortcuts", label: "Shortcuts", icon: <Keyboard className="h-4 w-4" /> },
    { id: "github", label: "GitHub", icon: <Github className="h-4 w-4" /> },
  ];

  const isMac = typeof navigator !== "undefined" && navigator.platform?.toUpperCase().includes("MAC");
  const mod = isMac ? "⌘" : "Ctrl";
  const shortcutsList = [
    { keys: `${mod}+K`, desc: "Quick actions (refactor, explain, docs) on selection" },
    { keys: "Ctrl+Shift+D", desc: "Toggle diff (current file vs last saved)" },
    { keys: "Ctrl+`", desc: "Toggle terminal" },
    { keys: `${mod}+S`, desc: "Save current file" },
    { keys: "F12", desc: "Go to definition (symbol under cursor)" },
    { keys: "Shift+F12", desc: "Find references" },
    { keys: "Agent: Rerun", desc: "Generate a new plan from the same instruction" },
    { keys: "Agent: Re-run same plan", desc: "Execute the same plan again (no new plan)" },
  ];

  return (
    <div className="flex flex-1 flex-col p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-4 flex items-center gap-2">
        <Settings className="h-5 w-5" />
        Settings
      </h1>
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 rounded-t-md px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-primary text-foreground bg-background"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "general" && (
        <div className="space-y-4">
          <section className="space-y-2">
            <Label className="text-base font-medium">Account</Label>
            <p className="text-sm text-muted-foreground">
              Manage your account and preferences. API keys are under the API Keys tab.
            </p>
          </section>
        </div>
      )}
      {activeTab === "keys" && (
        <div className="space-y-4">
          <section className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Key className="h-4 w-4" />
              LLM provider API keys
            </Label>
            <p className="text-sm text-muted-foreground">
              The app picks a best default model from your connected APIs and free models (Chat, Cmd+K, tab completion, Agent). You can change it anytime in the model dropdown in Chat or in the Agent panel.
            </p>
            <p className="text-sm text-muted-foreground">
              Tab completion tries <strong>Ollama first</strong> when you have an Ollama model in your default group (fast, local). Otherwise it uses a fast OpenRouter model (e.g. GPT-4o mini, Claude Haiku) when available. Set your default model group in Chat or Agent to control which model is used for completions.
            </p>
            <KeySettingsContent />
          </section>
        </div>
      )}
      {activeTab === "safety" && (
        <div className="space-y-4">
          <section className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Safety
            </Label>
            <p className="text-sm text-muted-foreground">
              Safe Edit mode limits large or risky changes and can block pushes when tests are failing.
            </p>
            <p className="text-sm text-muted-foreground">
              Protected files the AI won&apos;t edit without extra confirmation:{" "}
              <span className="font-mono text-xs">{DEFAULT_PROTECTED_PATTERNS.join(", ")}</span>
            </p>
          </section>
        </div>
      )}
      {activeTab === "shortcuts" && (
        <div className="space-y-4">
          <section className="space-y-2">
            <Label className="text-base font-medium flex items-center gap-2">
              <Keyboard className="h-4 w-4" />
              Keyboard shortcuts & actions
            </Label>
            <p className="text-sm text-muted-foreground">
              In-app shortcuts and Agent actions you can use while coding.
            </p>
            <ul className="space-y-2 mt-3">
              {shortcutsList.map((s) => (
                <li key={s.keys} className="flex items-start gap-3 text-sm">
                  <kbd className="shrink-0 rounded border border-border bg-muted/60 px-2 py-1 font-mono text-xs">
                    {s.keys}
                  </kbd>
                  <span className="text-muted-foreground">{s.desc}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {activeTab === "github" && (
        <div className="space-y-8">
          <section className="space-y-3">
            <Label className="text-base font-medium flex items-center gap-2">
              <Key className="h-4 w-4" />
              GitHub OAuth configuration
            </Label>
            <p className="text-sm text-muted-foreground">
              Optional. Set your GitHub OAuth App credentials to use &quot;Connect GitHub&quot; and create workspaces from your private repos. You can also set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env.local (env takes precedence).
            </p>
            {oauthConfig && (
              <p className="text-sm text-muted-foreground">
                {oauthConfig.configured ? (
                  <>Configured {oauthConfig.clientIdMasked && <span className="font-mono">({oauthConfig.clientIdMasked})</span>}. Update below to change.</>
                ) : (
                  "Not configured. Enter Client ID and Secret below."
                )}
              </p>
            )}
            <div className="grid gap-2">
              <Label htmlFor="github-client-id" className="text-xs">Client ID</Label>
              <Input
                id="github-client-id"
                type="text"
                placeholder="Ov23li…"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                autoComplete="off"
                className="font-mono text-sm"
              />
              <Label htmlFor="github-client-secret" className="text-xs">Client secret</Label>
              <Input
                id="github-client-secret"
                type="password"
                placeholder="Leave blank to keep existing"
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                autoComplete="off"
                className="font-mono text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSaveOAuthConfig}
                disabled={oauthSaving}
              >
                {oauthSaving ? "Saving…" : oauthClientId.trim() || oauthClientSecret.trim() ? "Save credentials" : "Clear credentials"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Leave secret blank to keep the existing one. Clear both and click Clear credentials to remove.
              </p>
            </div>
          </section>
          <section className="space-y-3 border-t border-border pt-6">
            <Label className="text-base font-medium flex items-center gap-2">
              <Github className="h-4 w-4" />
              Connect GitHub
            </Label>
            <p className="text-sm font-medium text-muted-foreground">What happens when you connect GitHub</p>
            <p className="text-sm text-muted-foreground">
              You can connect your GitHub account, open any repo (including private ones), and let the AI read and understand your code. When you ask it to, it can create a branch, apply edits, commit, push, and open a pull request for you. Every write goes through a confirmation dialog first, and it never modifies your default branch without your explicit approval.
            </p>
            {message && (
              <p className="text-sm text-amber-600 dark:text-amber-400">{message}</p>
            )}
            {status?.linked ? (
              <div className="flex items-center gap-3 rounded-lg border border-border p-3">
                {status.avatarUrl ? (
                  <img
                    src={status.avatarUrl}
                    alt=""
                    className="h-10 w-10 rounded-full"
                  />
                ) : (
                  <Github className="h-10 w-10 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{status.username}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    GitHub is connected. You can open any repo, let the AI read your code, and when you ask it to, it can create a branch, apply edits, commit, push, and open a PR—each write after your confirmation, and it never touches your default branch.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                >
                  {disconnecting ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            ) : (
              <Button asChild>
                <a href="/api/auth/github/connect">
                  <Github className="mr-2 h-4 w-4" />
                  Connect GitHub
                </a>
              </Button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center">Loading settings…</div>}>
      <SettingsContent />
    </Suspense>
  );
}
