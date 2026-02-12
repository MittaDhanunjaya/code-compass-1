import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Skip prerendering: requires Supabase env vars at request time (not available in CI build)
export const dynamic = "force-dynamic";

export default async function AppPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/sign-in");

  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id")
    .order("updated_at", { ascending: false })
    .limit(1);

  if (workspaces?.length) {
    redirect(`/app/${workspaces[0].id}`);
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <h2 className="text-lg font-medium">No workspace yet</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Create a workspace from the sidebar to get started.
      </p>
    </div>
  );
}
