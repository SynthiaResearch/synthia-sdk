import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/**
 * ENV POLICY — the CLI reads exactly these environment variables and never
 * iterates process.env. SYNTHIA_API_KEY (the only secret) and
 * SYNTHIA_BASE_URL are read by the SDK client; everything here is
 * non-secret CI context. Keep it that way: what a CI tool reads from the
 * environment is an audit surface (see the Codecov 2021 incident).
 */
const GH = [
  "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF", "GITHUB_EVENT_NAME", "GITHUB_RUN_ID", "GITHUB_SERVER_URL",
] as const;

export interface CiContext {
  provider?: string;
  repo?: string;
  branch?: string;
  commit_sha?: string;
  run_id?: string;
  run_url?: string;
  pr?: number;
  isCi: boolean;
}

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** owner/repo slug from a git remote URL (https or ssh), else null. */
function remoteSlug(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

export function detectCi(): CiContext {
  const env = Object.fromEntries(GH.map((k) => [k, process.env[k]]));
  if (env["GITHUB_ACTIONS"] === "true") {
    const repo = env["GITHUB_REPOSITORY"];
    const runId = env["GITHUB_RUN_ID"];
    // On pull_request events GITHUB_REF_NAME is "<n>/merge"; the branch
    // under test is GITHUB_HEAD_REF. On push it's the pushed branch.
    const headRef = env["GITHUB_HEAD_REF"];
    const refName = env["GITHUB_REF_NAME"];
    const pr = headRef && refName?.endsWith("/merge")
      ? Number.parseInt(refName, 10) || undefined
      : undefined;
    return {
      provider: "github",
      repo,
      branch: headRef || refName,
      commit_sha: env["GITHUB_SHA"],
      run_id: runId,
      run_url: repo && runId
        ? `${env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${repo}/actions/runs/${runId}`
        : undefined,
      pr,
      isCi: true,
    };
  }
  // Local run: best-effort provenance from git, so a laptop `synthia run`
  // on main can seed the baseline too.
  const slug = remoteSlug(git("config", "--get", "remote.origin.url"));
  return {
    provider: undefined,
    repo: slug ?? undefined,
    branch: git("rev-parse", "--abbrev-ref", "HEAD") ?? undefined,
    commit_sha: git("rev-parse", "HEAD") ?? undefined,
    isCi: false,
  };
}

/** Stable CI session identity: one session groups every CI run of a repo,
 * across branches — which is what makes the baseline query work. */
export function ciSessionName(ctx: CiContext): string {
  return `ci/${ctx.repo ?? basename(process.cwd())}`;
}
