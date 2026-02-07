/**
 * v1 GitHub import: clone public repo and import files into workspace_files.
 * Read-only: no push, commits, or PRs. Uses same sandbox pattern as runCommand.
 */

import { spawn } from "child_process";
import { mkdir, readdir, readFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".next", "dist", "build", ".venv", "venv"]);
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mp3", ".webm", ".bin", ".pyc", ".class",
]);

export function getCloneRoot(workspaceId: string): string {
  const base = process.env.WORKSPACE_BASE_DIR || join(tmpdir(), "workspaces");
  return resolve(base, workspaceId, "github-repo");
}

function isBinary(buffer: Buffer): boolean {
  const slice = buffer.subarray(0, Math.min(8192, buffer.length));
  return slice.some((b) => b === 0);
}

function shouldSkipPath(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  const lower = relativePath.toLowerCase();
  if (SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return false;
}

export type ImportedFile = { path: string; content: string };

/**
 * Clone a public repo into workspace sandbox. Uses git clone --depth 1.
 * Returns the absolute path to the repo root.
 */
export function cloneRepo(
  workspaceId: string,
  repoUrl: string,
  branch: string
): Promise<string> {
  const cloneRoot = getCloneRoot(workspaceId);
  return new Promise((resolvePromise, rejectPromise) => {
    mkdir(cloneRoot, { recursive: true })
      .then(() => {
        const child = spawn(
          "git",
          ["clone", "--depth", "1", "-b", branch, repoUrl, "."],
          { cwd: cloneRoot, stdio: ["ignore", "pipe", "pipe"] }
        );
        let stderr = "";
        child.stderr?.on("data", (d) => { stderr += d.toString(); });
        child.on("error", (err) => rejectPromise(err));
        child.on("close", (code) => {
          if (code === 0) resolvePromise(cloneRoot);
          else rejectPromise(new Error(`git clone failed: ${stderr || `exit ${code}`}`));
        });
      })
      .catch(rejectPromise);
  });
}

/**
 * Walk repo directory and collect text files (path relative to repo root).
 * Skips: .git, node_modules, binary/large files, and skip-extensions.
 */
export async function walkRepo(repoRoot: string): Promise<ImportedFile[]> {
  const results: ImportedFile[] = [];

  async function walk(dir: string, relativePrefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = relativePrefix ? `${relativePrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name), rel);
      } else {
        if (shouldSkipPath(rel)) continue;
        const fullPath = join(dir, e.name);
        try {
          const buf = await readFile(fullPath);
          if (buf.length > MAX_FILE_SIZE_BYTES) continue;
          if (isBinary(buf)) continue;
          const content = buf.toString("utf-8");
          results.push({ path: rel, content });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(repoRoot, "");
  return results;
}

/**
 * Remove cloned repo directory (after import or on error).
 */
export async function removeClone(workspaceId: string): Promise<void> {
  const cloneRoot = getCloneRoot(workspaceId);
  if (existsSync(cloneRoot)) {
    await rm(cloneRoot, { recursive: true, force: true });
  }
}

export type ImportResult = {
  filesImported: number;
  filesSkipped?: number;
};

/** Clone with token for private repos. URL: https://x-access-token:TOKEN@github.com/owner/repo.git */
export function cloneRepoWithToken(
  workspaceId: string,
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<string> {
  const repoUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
  return cloneRepo(workspaceId, repoUrl, branch);
}

/** Run git pull in the workspace repo dir. Repo must exist. Use authUrl for private. */
export function pullRepo(
  workspaceId: string,
  branch: string,
  authUrl?: string
): Promise<void> {
  const cloneRoot = getCloneRoot(workspaceId);
  if (!existsSync(cloneRoot)) {
    return Promise.reject(new Error("Repo directory not found; run import or pull first."));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const args = authUrl
      ? ["pull", authUrl, branch]
      : ["pull", "origin", branch];
    const child = spawn("git", args, {
      cwd: cloneRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git pull failed: ${stderr || `exit ${code}`}`));
    });
  });
}

/** Write workspace_files content into the repo directory (overwrite). */
export async function syncWorkspaceFilesToRepo(
  workspaceId: string,
  files: { path: string; content: string }[]
): Promise<void> {
  const cloneRoot = getCloneRoot(workspaceId);
  const { writeFile, mkdir } = await import("fs/promises");
  for (const f of files) {
    const fullPath = join(cloneRoot, f.path);
    const dir = join(fullPath, "..");
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, f.content, "utf-8");
  }
}

export type GitStatusEntry = { path: string; status: string };

/** Run git status --porcelain; return parsed modified/added/deleted. */
export async function getGitStatus(workspaceId: string): Promise<GitStatusEntry[]> {
  const cloneRoot = getCloneRoot(workspaceId);
  if (!existsSync(cloneRoot)) return [];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["status", "--porcelain", "-u"], {
      cwd: cloneRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      if (code !== 0) return rejectPromise(new Error("git status failed"));
      const lines = out.trim().split("\n").filter(Boolean);
      const entries: GitStatusEntry[] = lines.map((line) => {
        const status = line.slice(0, 2).trim();
        const path = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
        return { path, status };
      });
      resolvePromise(entries);
    });
  });
}

function authUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

/** Checkout default branch, create new branch, push with token. */
export async function createBranchFromDefault(
  workspaceId: string,
  newBranch: string,
  defaultBranch: string,
  owner: string,
  repo: string,
  token: string
): Promise<void> {
  const cloneRoot = getCloneRoot(workspaceId);
  const url = authUrl(owner, repo, token);
  const run = (args: string[]) =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd: cloneRoot, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => rejectPromise(err));
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`${args.join(" ")} failed: ${stderr || `exit ${code}`}`));
      });
    });
  await run(["fetch", url]);
  await run(["checkout", defaultBranch]);
  await run(["pull", url, defaultBranch]);
  await run(["checkout", "-b", newBranch]);
  await run(["push", "-u", url, newBranch]);
}

/** Commit all changes and push to current branch using token. */
export async function commitAndPush(
  workspaceId: string,
  owner: string,
  repo: string,
  currentBranch: string,
  message: string,
  token: string
): Promise<void> {
  const cloneRoot = getCloneRoot(workspaceId);
  const url = authUrl(owner, repo, token);
  const run = (args: string[]) =>
    new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd: cloneRoot, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => rejectPromise(err));
      child.on("close", (code) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`${args.join(" ")} failed: ${stderr || `exit ${code}`}`));
      });
    });
  await run(["add", "-A"]);
  await run(["commit", "-m", message]);
  await run(["push", url, `HEAD:${currentBranch}`]);
}
