/**
 * GitHub over the `gh` CLI. Transient failures (network, 5xx, rate limit)
 * are retried with a short backoff so a flaky connection does not fail a
 * long run; anything else throws with stderr.
 */
import { byId, matchesList, parseBlockedBy, QUALIFIED_REF, stateLabels, swapStateLabel, type Tracker, type Issue } from "../ports/tracker.js";
import { exec as defaultExec, ExecError, must, type Exec } from "./exec.js";

export type GitHubOptions = {
  exec?: Exec;
  /** Repository checkout `gh` resolves `{owner}/{repo}` from. */
  cwd?: string;
  /**
   * `owner/name` of the repository the issues live in, when it is not the
   * checkout's: `-R` on every command, the path of every `gh api` endpoint
   * (which has no `-R`). `trackerOptions.repo` in `sous.yaml`.
   */
  repo?: string;
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

export { parseBlockedBy } from "../ports/tracker.js";

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

  /** Addresses `options.repo`, unless the call names its own repository (`-R` of a qualified blocker). */
  const addressed = (args: readonly string[], own: boolean): readonly string[] => {
    const { repo } = options;
    if (repo === undefined || own) return args;
    if (args[0] === "api") return args.map((a) => a.replace("repos/{owner}/{repo}/", `repos/${repo}/`));
    return [...args, "-R", repo];
  };

  const ghResult = async (command: readonly string[], own = false) => {
    const args = addressed(command, own);
    for (let attempt = 1; ; attempt++) {
      const result = await exec("gh", args, execOptions);
      if (result.code === 0 || attempt > retries || !isTransient(result.stderr)) return result;
      warn(`${new ExecError(what(args), result).message} (attempt ${attempt}/${retries + 1}, retrying)`);
      await sleep(backoffMs(attempt));
    }
  };

  const gh = async (args: readonly string[], own = false): Promise<string> => must(await ghResult(args, own), what(args));

  /** `#96` and `96` name the same issue. */
  const numberOf = (id: string): string => id.replace(/^#/, "");

  const getIssue = async (id: string): Promise<Issue> => toIssue(JSON.parse(await gh(["issue", "view", numberOf(id), "--json", ISSUE_FIELDS])) as RawIssue);

  /** An `owner/repo#n` blocker is asked of its own repository; anything else is an issue of this one. */
  const stateOf = async (ref: string): Promise<Issue["state"]> => {
    const qualified = QUALIFIED_REF.exec(ref);
    if (qualified === null) return (await getIssue(ref)).state;
    const [, repo = "", number = ""] = qualified;
    return toIssue(JSON.parse(await gh(["issue", "view", number, "-R", repo, "--json", ISSUE_FIELDS], true)) as RawIssue).state;
  };

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
      for (const blocker of listed) if ((await stateOf(blocker)) !== "closed") open.push(blocker);
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
    isClosed: async (id) => (await stateOf(id)) === "closed",
    async list({ labels }) {
      // The REST endpoint pages to the end where `gh issue list` stops at its --limit. Its `labels` ANDs a
      // comma-separated list, so a label with a comma in it is matched here only; pull requests are left out.
      const asked = labels.filter((l) => !l.includes(","));
      const query = `state=open&per_page=100${asked.length > 0 ? `&labels=${encodeURIComponent(asked.join(","))}` : ""}`;
      const out = await gh(["api", "--paginate", `repos/{owner}/{repo}/issues?${query}`, "--jq", ".[] | select(.pull_request == null)"]);
      const rows = out.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as RawIssue);
      return rows
        .map(toIssue)
        .filter((i) => matchesList(i, labels))
        .sort(byId);
    },
  };
};
