/**
 * The issue tracker as a step sees it via `ctx.tracker`, plus the pure helpers that
 * define the issue-body and label contract. The helpers live here so the
 * real adapter, the fake and the steps share one definition.
 */
import type { Issue as PublicIssue } from "../index.js";

export type IssueState = "open" | "closed";

/** The public `Issue` plus its open/closed state. */
export type Issue = PublicIssue & { state: IssueState };

/**
 * Every method takes the tracker's own id, as `Issue.id` carries it.
 * `claim`, `block` and `close` are the run's lifecycle: the core calls them
 * under `lifecycle: core`, steps may call them under `lifecycle: steps`.
 */
export type Tracker = {
  getIssue(id: string): Promise<Issue>;
  /** Ids of the native children of `parent` (GitHub sub-issues, a bd epic's beads), open and closed, in the order work should pick them. */
  children(parent: string): Promise<string[]>;
  /** Id of the native parent, or undefined for a top-level issue. */
  parent(id: string): Promise<string | undefined>;
  /** Ids of the issues still open that must close before `id` may start; how a blocker is recorded is the tracker's business. */
  blockers(id: string): Promise<string[]>;
  /**
   * Marks the issue as being worked on by the run on `branch` (GitHub: the
   * `<prefix>:running` label; bd: `--claim` as `sous:<branch>`). Idempotent
   * for the same run; a tracker that knows another worker holds it throws.
   */
  claim(id: string, run: { branch: string }): Promise<void>;
  /** The run stopped and needs a human: the `<prefix>:blocked` state plus `comment`. */
  block(id: string, comment: string): Promise<void>;
  close(id: string, comment?: string): Promise<void>;
  /** Adds `label` and removes every other label sharing its `<prefix>:` from the issue; creates the label where the tracker needs that. */
  setStateLabel(id: string, label: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  isClosed(id: string): Promise<boolean>;
};

/** What a project's own tracker module must implement; `sous validate` checks for these. */
export const TRACKER_METHODS = ["getIssue", "children", "parent", "blockers", "claim", "block", "close", "setStateLabel", "comment", "isClosed"] as const;

/** `sous:` of `sous:running`; undefined for a label without a colon. */
export const labelPrefixOf = (label: string): string | undefined => {
  const colon = label.indexOf(":");
  return colon === -1 ? undefined : label.slice(0, colon + 1);
};

/** The two lifecycle states the core writes, under the project's `labelPrefix`. */
export const stateLabels = (prefix: string): { running: string; blocked: string } => ({ running: `${prefix}:running`, blocked: `${prefix}:blocked` });

/**
 * Labels after swapping in `label`. A run's state labels share the label's
 * own `<prefix>:`, so no settings are needed to know which ones to remove.
 */
export const swapStateLabel = (current: readonly string[], label: string): { add: string[]; remove: string[]; labels: string[] } => {
  const prefix = labelPrefixOf(label);
  const remove = current.filter((l) => prefix !== undefined && l.startsWith(prefix) && l !== label);
  const add = current.includes(label) ? [] : [label];
  const labels = [...current.filter((l) => !remove.includes(l)), ...add];
  return { add, remove, labels };
};
