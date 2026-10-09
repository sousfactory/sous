/**
 * What GitHub knows about a run's squash commit, through `gh` in the
 * repository checkout: the Actions runs it triggered, or whether the commit
 * is on GitHub at all. A lookup is cached; it is asked again after `ttlMs`
 * until every workflow run has completed, and never after that.
 */
import { execFile } from "node:child_process";

export type ActionsRunView = {
  workflow: string;
  url: string;
  /** GitHub's `status`: queued, in_progress, completed, … */
  status: string;
  /** GitHub's `conclusion` once completed: success, failure, cancelled, skipped, … */
  conclusion?: string;
  startedAt?: string;
  updatedAt?: string;
};

export type GitHubView =
  | { state: "none" }
  | { state: "unpushed"; sha: string }
  | { state: "no-workflow"; sha: string; commitUrl: string }
  | { state: "runs"; sha: string; runs: ActionsRunView[]; final: boolean }
  | { state: "unavailable"; sha: string; error: string };

/** Runs `gh <args>` in the checkout; resolves stdout, rejects with stderr. */
export type Gh = (args: string[]) => Promise<string>;

export const ghIn =
  (cwd: string): Gh =>
  (args) =>
    new Promise((resolve, reject) =>
      execFile("gh", args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
        error === null ? resolve(stdout) : reject(new Error((stderr || error.message).trim())),
      ),
    );

type WorkflowRun = { name: string; html_url: string; status: string; conclusion: string | null; run_started_at?: string; updated_at?: string; created_at: string };

/** A re-run is a separate run on GitHub; only the latest per workflow counts. */
const latestPerWorkflow = (runs: WorkflowRun[]): ActionsRunView[] => {
  const byName = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const seen = byName.get(run.name);
    if (seen === undefined || run.created_at > seen.created_at) byName.set(run.name, run);
  }
  return [...byName.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      workflow: r.name,
      url: r.html_url,
      status: r.status,
      ...(r.conclusion !== null ? { conclusion: r.conclusion } : {}),
      ...(r.run_started_at !== undefined ? { startedAt: r.run_started_at } : {}),
      ...(r.updated_at !== undefined ? { updatedAt: r.updated_at } : {}),
    }));
};

/** GitHub's answer for a commit it does not have. */
const NOT_ON_GITHUB = /No commit found|HTTP 404|HTTP 422/;

const ask = async (gh: Gh, sha: string): Promise<GitHubView> => {
  let runs: WorkflowRun[];
  try {
    runs = (JSON.parse(await gh(["api", `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=50`])) as { workflow_runs: WorkflowRun[] }).workflow_runs;
  } catch (error) {
    return { state: "unavailable", sha, error: error instanceof Error ? error.message : String(error) };
  }
  if (runs.length > 0) {
    const views = latestPerWorkflow(runs);
    return { state: "runs", sha, runs: views, final: views.every((r) => r.status === "completed") };
  }
  try {
    const commitUrl = (await gh(["api", `repos/{owner}/{repo}/commits/${sha}`, "--jq", ".html_url"])).trim();
    return { state: "no-workflow", sha, commitUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NOT_ON_GITHUB.test(message) ? { state: "unpushed", sha } : { state: "unavailable", sha, error: message };
  }
};

export type GitHubLookup = (sha: string | undefined) => Promise<GitHubView>;

export const createGitHubLookup = (gh: Gh, { ttlMs = 30_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}): GitHubLookup => {
  const cache = new Map<string, { at: number; view: Promise<GitHubView> }>();
  return async (sha) => {
    if (sha === undefined) return { state: "none" };
    const hit = cache.get(sha);
    if (hit !== undefined) {
      const view = await hit.view;
      if ((view.state === "runs" && view.final) || now() - hit.at < ttlMs) return view;
    }
    const view = ask(gh, sha);
    cache.set(sha, { at: now(), view });
    return view;
  };
};
