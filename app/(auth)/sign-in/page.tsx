"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function handleSignInWithOAuth(provider: "github" | "google") {
    setError(null);
    try {
      const supabase = createClient();
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const options: { redirectTo: string; scopes?: string } = { redirectTo: `${origin}/auth/callback` };
      if (provider === "github") options.scopes = "repo read:user";
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options,
      });
      if (error) {
        setError(error.message);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : `Sign in with ${provider === "github" ? "GitHub" : "Google"} failed`);
    }
  }

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">AIForge</h1>
        <p className="mt-1 text-muted-foreground">Sign in to continue</p>
        <p className="mt-3 text-sm text-muted-foreground">
          You can connect your GitHub account, open any repo (including private ones), and let the AI read and understand your code. When you ask it to, it can create a branch, apply edits, commit, push, and open a pull request for you. Every write goes through a confirmation dialog first, and it never modifies your default branch without your explicit approval.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            disabled={loading}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            disabled={loading}
          />
        </div>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase text-muted-foreground">
          <span className="bg-background px-2">Or sign in with</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => handleSignInWithOAuth("google")}
        >
          Google
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => handleSignInWithOAuth("github")}
        >
          GitHub
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        You can connect your GitHub account, open any repo (including private ones), and let the AI read and understand your code. When you ask it to, it can create a branch, apply edits, commit, push, and open a pull request for you. Every write goes through a confirmation dialog first, and it never modifies your default branch without your explicit approval.
      </p>
      <p className="text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link href="/sign-up" className="text-primary underline-offset-4 hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
