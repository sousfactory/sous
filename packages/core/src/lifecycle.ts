/**
 * What the core writes to the run's issue, so people can follow a run
 * without the CLI: claimed at the start (`<prefix>:running` on GitHub, a bd
 * claim), blocked with a comment when it needs a human, closed on `done`.
 * `lifecycle: steps` makes every call a no-op and leaves all of it to steps.
 */
import { stepsOf, type Session } from "./exec/scope.js";
import type { Tracker } from "./ports/tracker.js";
import { iterationOf, logTail } from "./session/update.js";

export type LifecycleMode = "core" | "steps";

/** Tells the human where the worktree is and how to resume after fixing it. */
export const blockedComment = (session: Session, worktreePath: string): string => {
  const step = session.current;
  const iterations = iterationOf(session, step);
  const tail = logTail(stepsOf(session)[step]?.log ?? "");
  return [
    `Blocked in \`${step}\` after ${iterations} iteration${iterations === 1 ? "" : "s"}.`,
    "",
    ...(tail.length > 0 ? ["Last eval:", "```", tail, "```", ""] : []),
    `Worktree kept at \`${worktreePath}\` on \`${session.branch}\`.`,
    `Fix things by hand there, then run \`sous run ${session.flow} ${session.issue}\` again; it re-enters at this step's eval.`,
  ].join("\n");
};

export type LifecycleDeps = {
  tracker: Tracker;
  issue: string;
  mode: LifecycleMode;
};

export type Lifecycle = {
  readonly mode: LifecycleMode;
  claim(branch: string): Promise<void>;
  block(session: Session, worktreePath: string): Promise<void>;
  close(): Promise<void>;
};

export const createLifecycle = ({ tracker, issue, mode }: LifecycleDeps): Lifecycle => ({
  mode,
  async claim(branch) {
    if (mode === "core") await tracker.claim(issue, { branch });
  },
  async block(session, worktreePath) {
    if (mode === "core") await tracker.block(issue, blockedComment(session, worktreePath));
  },
  async close() {
    if (mode === "core") await tracker.close(issue);
  },
});
