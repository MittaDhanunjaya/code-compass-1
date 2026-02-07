"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";

type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (
    email: string,
    password: string
  ) => Promise<{ error: Error | null; session: Session | null }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = useMemo((): SupabaseClient | null => {
    try {
      return createClient();
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase!.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return { error: new Error("Supabase not configured") };
      try {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error as Error | null };
      } catch (e) {
        return {
          error: new Error(
            e instanceof TypeError && e.message === "Failed to fetch"
              ? "Network error: cannot reach Supabase. Check your internet connection and that NEXT_PUBLIC_SUPABASE_URL is correct."
              : e instanceof Error
                ? e.message
                : "Sign in failed"
          ),
        };
      }
    },
    [supabase]
  );

  const signUp = useCallback(
    async (email: string, password: string) => {
      if (!supabase) return { error: new Error("Supabase not configured"), session: null };
      try {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo:
              typeof window !== "undefined"
                ? `${window.location.origin}/auth/callback`
                : undefined,
          },
        });
        if (error) return { error: error as Error, session: null };
        // If session exists (email confirmation disabled), user is already signed in
        if (data.session) {
          setSession(data.session);
          setUser(data.session.user);
          return { error: null, session: data.session };
        }
        return { error: null, session: null };
      } catch (e) {
        return {
          error: new Error(
            e instanceof TypeError && e.message === "Failed to fetch"
              ? "Network error: cannot reach Supabase. Check your internet connection and that NEXT_PUBLIC_SUPABASE_URL is correct."
              : e instanceof Error
                ? e.message
                : "Sign up failed"
          ),
          session: null,
        };
      }
    },
    [supabase]
  );

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
  }, [supabase]);

  const value: AuthContextValue = {
    user,
    session,
    loading,
    signIn,
    signUp,
    signOut,
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
