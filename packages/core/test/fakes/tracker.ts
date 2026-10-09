import { parseBlockedBy } from "../../src/adapters/github.js";
import { stateLabels, swapStateLabel, type Tracker, type Issue } from "../../src/ports/tracker.js";

export type FakeTracker = Tracker & {
  /** Live issue store, keyed by id; tests may read and edit it. */
  readonly issues: Map<string, Issue>;
  /** Parent id -> sub-issue ids, in pick order. */
  readonly subIssues: Map<string, string[]>;
  readonly comments: { issue: string; body: string }[];
  /** Every `claim`, in order. */
  readonly claims: { issue: string; branch: string }[];
};

export type FakeTrackerOptions = {
  issues?: Issue[];
  subIssues?: Record<string, string[]>;
  labelPrefix?: string;
};

/** An issue written GitHub-style: `ref` is `#<id>` unless given. */
export const issue = (overrides: Partial<Issue> & { id: string }): Issue => ({
  ref: `#${overrides.id}`,
  title: `Issue #${overrides.id}`,
  body: "## Acceptance criteria\n- [ ] works\n\n## Blocked by\nNone\n",
  state: "open",
  labels: [],
  ...overrides,
});

export const fakeTracker = (options: FakeTrackerOptions = {}): FakeTracker => {
  const issues = new Map((options.issues ?? []).map((i) => [i.id, i]));
  const subIssues = new Map(Object.entries(options.subIssues ?? {}));
  const comments: FakeTracker["comments"] = [];
  const claims: FakeTracker["claims"] = [];
  const { running, blocked } = stateLabels(options.labelPrefix ?? "sous");

  const get = (id: string): Issue => {
    const found = issues.get(id);
    if (found === undefined) throw new Error(`fakeTracker: no issue ${id}`);
    return found;
  };
  const setStateLabel = async (id: string, label: string): Promise<void> => {
    const current = get(id);
    issues.set(id, { ...current, labels: swapStateLabel(current.labels, label).labels });
  };
  const comment = async (id: string, body: string): Promise<void> => {
    get(id);
    comments.push({ issue: id, body });
  };

  return {
    issues,
    subIssues,
    comments,
    claims,
    async getIssue(id) {
      return { ...get(id), labels: [...get(id).labels] };
    },
    async children(parent) {
      return [...(subIssues.get(parent) ?? [])];
    },
    async parent(id) {
      get(id);
      for (const [parent, children] of subIssues) if (children.includes(id)) return parent;
      return undefined;
    },
    /** GitHub-style: the body's `## Blocked by` ids, minus the ones closed here; an unknown blocker counts as open. */
    async blockers(id) {
      return parseBlockedBy(get(id).body).filter((b) => issues.get(b)?.state !== "closed");
    },
    async claim(id, { branch }) {
      claims.push({ issue: id, branch });
      await setStateLabel(id, running);
    },
    async block(id, text) {
      await setStateLabel(id, blocked);
      await comment(id, text);
    },
    async close(id, text) {
      if (text !== undefined) await comment(id, text);
      issues.set(id, { ...get(id), state: "closed" });
    },
    setStateLabel,
    comment,
    async isClosed(id) {
      return get(id).state === "closed";
    },
  };
};
