import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AuthHashHandler } from "@/components/auth-hash-handler";

export default async function HomePage(props: {
  searchParams: Promise<{ code?: string; next?: string; type?: string }>;
}) {
  const searchParams = await props.searchParams;
  const code = typeof searchParams?.code === "string" ? searchParams.code : undefined;
  const type = typeof searchParams?.type === "string" ? searchParams.type : undefined;
  // Supabase recovery/confirm links often redirect to Site URL (/) with code in query.
  // Forward to our callback - use /reset-password for recovery, else /app.
  if (code) {
    const next =
      searchParams?.next ?? (type === "recovery" ? "/reset-password" : "/app");
    redirect(`/auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    redirect("/app");
  }
  // No user, no code: might be implicit flow (tokens in URL hash - server never sees it).
  // Render client handler to process hash and redirect to /reset-password or /sign-in.
  return <AuthHashHandler />;
}
