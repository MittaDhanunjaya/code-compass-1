/**
 * Server component that checks for required Supabase env vars on app load.
 * Renders a warning banner when vars are missing (e.g. during local setup).
 */
export function EnvCheck() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const isMissing =
    !url ||
    !anonKey ||
    url === "https://your-project.supabase.co" ||
    anonKey === "your-anon-key";

  if (!isMissing) return null;

  return (
    <div className="border-b border-amber-500/50 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-200">
      Code Compass: Supabase not configured. Copy{" "}
      <code className="rounded bg-amber-500/20 px-1">.env.local.example</code>{" "}
      to <code className="rounded bg-amber-500/20 px-1">.env.local</code> and
      add your project URL and anon key.
    </div>
  );
}
