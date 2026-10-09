/**
 * GitHub over the `gh` CLI. Transient failures (network, 5xx, rate limit)
 * are retried with a short backoff so a flaky connection does not fail a
 * long run; anything else throws with stderr.
 */
import { stateLabels, swapStateLabel, type Tracker, type Issue } from "../ports/tracker.js";
import { exec as defaultExec, ExecError, must, type Exec } from "./exec.js";

export type GitHubOptions = {
  exec?: Exec;
  /** Repository checkout `gh` resolves `{owner}/{repo}` from. */
  cwd?: string;
  /** `sous` of `sous:running`; the project's `labelPrefix` setting. */
  labelPrefix?: string;
  /** Retries after the first failed attempt. */
  retries?: number;
  /** Backoff before retry `attempt` (1-based), in ms. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
};

const TRANSIENT = /HTTP 5\d\d|timeout|timed out|TLS|connection reset|EOF|rate limit|ECONNRESET|ENOTFOUND|EAI_AGAIN/i;

export const isTransient = (stderr: string): boolean => TRANSIENT.test(stderr);

const ISSUE_FIELDS = "number,title,body,labels,state";

/**
 * Issue numbers listed under `## Blocked by` (`- #12`, `#13`, …) in a
 * body, the way the plan phase writes dependencies. A section reading
 * "None", or no section at all, yields `[]`.
 */
export const parseBlockedBy = (body: string): string[] => {
  const section = body.match(/(?:^|\n)##\s*Blocked by[^\n]*\n?([\s\S]*?)(?=\n##\s|$)/i)?.[1] ?? "";
  return [...section.matchAll(/#(\d+)/g)].map((m) => m[1] ?? "");
};

export type LabelSpec = { color: string; description: string };

/** Colours and descriptions for the labels sous creates; any other label gets GitHub's default grey. */
export const labelSpec = (prefix: string, name: string): LabelSpec => {
  const { running, blocked } = stateLabels(prefix);
  if (name === running) return { color: "1d76db", description: "sous run in progress" };
  if (name === blocked) return { color: "d93f0b", description: "sous run stopped; needs a human" };
  if (name === `${prefix}:merged`) return { color: "0e8a16", description: "sous squashed the branch into main" };
  return { color: "ededed", description: "" };
};

type RawIssue = {
  number: number;
  title: string;
  body?: string | null;
  labels?: { name: string }[];
  state?: string;
};

/** GitHub ids are the issue numbers; `#96` is how GitHub itself links them. */
export const toIssue = (raw: RawIssue): Issue => ({
  id: String(raw.number),
  ref: `#${raw.number}`,
  title: raw.title,
  body: raw.body ?? "",
  state: raw.state?.toLowerCase() === "closed" ? "closed" : "open",
  labels: (raw.labels ?? []).map((l) => l.name),
});

export const createGitHubTracker = (options: GitHubOptions = {}): Tracker => {
  const {
    exec = defaultExec,
    labelPrefix = "sous",
    retries = 3,
    backoffMs = (attempt) => attempt * 2000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    warn = (message) => console.warn(message),
  } = options;
  const execOptions = options.cwd !== undefined ? { cwd: options.cwd } : {};

  const what = (args: readonly string[]) => `gh ${args.slice(0, 2).join(" ")}`;

  const ghResult = async (args: readonly string[]) => {
    for (let attempt = 1; ; attempt++) {
      const result = await exec("gh", args, execOptions);
      if (result.code === 0 || attempt > retries || !isTransient(result.stderr)) return result;
      warn(`${new ExecError(what(args), result).message} (attempt ${attempt}/${retries + 1}, retrying)`);
      await sleep(backoffMs(attempt));
    }
  };

  const gh = async (args: readonly string[]): Promise<string> => must(await ghResult(args), what(args));

  /** `#96` and `96` name the same issue. */
  const numberOf = (id: string): string => id.replace(/^#/, "");

  const getIssue = async (id: string): Promise<Issue> => toIssue(JSON.parse(await gh(["issue", "view", numberOf(id), "--json", ISSUE_FIELDS])) as RawIssue);

  // A label must exist in the repository before an issue can carry it; once per process is enough.
  const ensured = new Set<string>();
  const ensureLabel = async (name: string): Promise<void> => {
    if (ensured.has(name)) return;
    const { color, description } = labelSpec(labelPrefix, name);
    await gh(["label", "create", name, "--color", color, "--description", description, "--force"]);
    ensured.add(name);
  };

  const setStateLabel = async (id: string, label: string): Promise<void> => {
    const { add, remove } = swapStateLabel((await getIssue(id)).labels, label);
    if (add.length === 0 && remove.length === 0) return;
    await ensureLabel(label);
    await gh(["issue", "edit", numberOf(id), ...add.flatMap((l) => ["--add-label", l]), ...remove.flatMap((l) => ["--remove-label", l])]);
  };

  const comment = async (id: string, body: string): Promise<void> => {
    await gh(["issue", "comment", numberOf(id), "--body", body]);
  };

  const { running, blocked } = stateLabels(labelPrefix);

  return {
    getIssue,
    async children(parent) {
      const out = await gh(["api", "--paginate", `repos/{owner}/{repo}/issues/${numberOf(parent)}/sub_issues`, "--jq", ".[].number"]);
      // Lowest number first: the order the sub-issues were written in.
      return out
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map(Number)
        .sort((a, b) => a - b)
        .map(String);
    },
    async parent(id) {
      const args = ["api", `repos/{owner}/{repo}/issues/${numberOf(id)}/parent`, "--jq", ".number"];
      const result = await ghResult(args);
      if (result.code === 0) return result.stdout.trim();
      if (/HTTP 404/.test(result.stderr)) return undefined;
      throw new ExecError(what(args), result);
    },
    async blockers(id) {
      const listed = parseBlockedBy((await getIssue(id)).body);
      const open: string[] = [];
      for (const blocker of listed) if ((await getIssue(blocker)).state !== "closed") open.push(blocker);
      return open;
    },
    claim: (id) => setStateLabel(id, running),
    async block(id, text) {
      await setStateLabel(id, blocked);
      await comment(id, text);
    },
    async close(id, text) {
      if (text !== undefined) await comment(id, text);
      await gh(["issue", "close", numberOf(id)]);
    },
    setStateLabel,
    comment,
    isClosed: async (id) => (await getIssue(id)).state === "closed",
  };
};
