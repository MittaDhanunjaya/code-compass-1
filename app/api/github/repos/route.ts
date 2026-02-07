import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/encrypt";

const GITHUB_REPOS_URL = "https://api.github.com/user/repos?per_page=100&sort=updated";

type RepoItem = {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  html_url: string;
};

/**
 * GET /api/github/repos
 * Lists the current user's GitHub repos (requires linked GitHub account).
 * Returns owner/repo, visibility, default_branch. Token never sent to client.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: gh, error } = await supabase
    .from("user_github")
    .select("github_access_token_encrypted")
    .eq("user_id", user.id)
    .single();

  if (error || !gh?.github_access_token_encrypted) {
    return NextResponse.json(
      { error: "GitHub account not linked. Connect GitHub in Settings." },
      { status: 400 }
    );
  }

  let token: string;
  try {
    token = decrypt(gh.github_access_token_encrypted);
  } catch {
    return NextResponse.json(
      { error: "GitHub token invalid. Reconnect in Settings." },
      { status: 500 }
    );
  }

  const res = await fetch(GITHUB_REPOS_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `GitHub API error: ${res.status}` },
      { status: 502 }
    );
  }
  const repos = (await res.json()) as RepoItem[];
  const list = repos.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    repo: r.name,
    private: r.private,
    defaultBranch: r.default_branch ?? "main",
    url: r.html_url,
  }));

  return NextResponse.json({ repos: list });
}
