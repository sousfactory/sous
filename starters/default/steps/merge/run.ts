/**
 * Squashes the branch into the base-branch checkout, cleans up, labels the
 * issue and comments the result. Closing the issue is the run's lifecycle
 * (`lifecycle: core` closes it on `done`). Pushes only with a `push` remote. Idempotent so a
 * rerun after a crash neither squashes twice nor fails on what is already
 * removed.
 *
 * With `resync: true` it lands only what was synced: when the base branch
 * has commits the branch does not contain (another run merged since the
 * last sync), it merges nothing and answers `stale: true`, for a route back
 * to sync. Without it, the branch is squashed onto whatever the base is.
 *
 * The checks and the squash run under `ctx.repoLock`, as one transaction on
 * the shared checkout: a merge by a parallel run in between would land this
 * branch on a base it was never synced with, past the freshness check.
 *
 * With `push: <remote>` the transaction also starts by fast-forwarding the
 * base from the remote, so the freshness check sees what others landed
 * there, and ends by pushing the base. A failed push keeps the squash: it is
 * the work, and a rerun finds the branch merged and pushes again.
 */
import { SousError, isOutput, type Ctx, type Event, type RunFn, type WorkRecord } from "sous-factory";
import { findingsOf, formatFinding, isBlocking, type Finding } from "../review/findings.js";
import { requireString } from "../_shared.js";

const FIX_LABELS: ReadonlySet<string> = new Set(["type:task", "type:bug"]);

/** `feat(<ref>): title`, or `fix(<ref>): title` for a task or bug by its `type:*` label. */
export const mergeMessage = (issue: { ref: string; title: string; labels: readonly string[] }): string =>
  `${issue.labels.some((l) => FIX_LABELS.has(l)) ? "fix" : "feat"}(${issue.ref}): ${issue.title}`;

/** Review findings that were logged, not fixed: every non-blocking finding of every review-shaped output in the log. */
export const minorFindings = (events: readonly Event[]): Finding[] =>
  events
    .filter(isOutput)
    .flatMap((o) => findingsOf(o.envelope.output) ?? [])
    .filter((f) => !isBlocking(f));

export type MergeSummary = {
  baseBranch: string;
  /** The remote the base branch was pushed to; absent when the step does not push. */
  pushedTo?: string;
  sha: string;
  message: string;
  /** The run target's id; its own progress entry is the run itself and is not listed. */
  issue: string;
  workProgress: Readonly<Record<string, WorkRecord>>;
  minors: readonly Finding[];
};

export const mergeComment = ({ baseBranch, pushedTo, sha, message, issue, workProgress, minors }: MergeSummary): string => {
  const entries = Object.entries(workProgress).filter(([id]) => id !== issue);
  return [
    `Merged into \`${baseBranch}\` as ${sha.slice(0, 7)}${pushedTo !== undefined ? ` and pushed to \`${pushedTo}\`` : ""}: \`${message}\``,
    ...(entries.length > 0 ? ["", "Sub-issues:", ...entries.map(([id, r]) => `- ${id}: ${r.state}, ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}`)] : []),
    ...(minors.length > 0 ? ["", "Minor review findings (logged, not fixed):", ...minors.map((f) => `- ${formatFinding(f)}`)] : []),
  ].join("\n");
};

/** The comment for a squash that landed on the local base but did not reach the remote. */
export const unpushedComment = ({ baseBranch, sha, message, remote, error }: { baseBranch: string; sha: string; message: string; remote: string; error: string }): string =>
  `Merged into \`${baseBranch}\` as ${sha.slice(0, 7)}: \`${message}\`; the merge landed locally and was not pushed to \`${remote}\`:\n\n\`\`\`\n${error}\n\`\`\``;

/** Close the sandbox, remove the worktree and delete the branch; each may already be gone. */
export const cleanUpMerged = async (ctx: Pick<Ctx, "git" | "sandbox" | "repoRoot" | "worktree" | "branch">): Promise<void> => {
  await ctx.sandbox.close();
  await ctx.git.removeWorktree(ctx.repoRoot, ctx.worktree);
  if (await ctx.git.branchExists(ctx.repoRoot, ctx.branch)) await ctx.git.deleteBranch(ctx.repoRoot, ctx.branch, { force: true });
};

/** What the transaction on the checkout decides: `undefined` when the branch is stale and nothing was merged. */
type Landed = { sha: string; alreadyMerged: boolean; pushError?: string };

export default (async (ctx, inputs) => {
  const baseBranch = requireString(inputs, "baseBranch", "merge");
  const { git, repoRoot, branch, issue } = ctx;
  const message = mergeMessage(issue);
  const remote = inputs["push"] === undefined ? undefined : requireString(inputs, "push", "merge");

  const landed = await ctx.repoLock(async (): Promise<Landed | undefined> => {
    const checkedOut = await git.currentBranch(repoRoot);
    if (checkedOut !== baseBranch) throw new SousError(`merge: refusing to merge: ${repoRoot} has ${checkedOut} checked out, not ${baseBranch}`);
    if (await git.isDirty(repoRoot)) throw new SousError(`merge: refusing to merge: the ${baseBranch} checkout at ${repoRoot} has uncommitted changes`);
    if (remote !== undefined && !(await git.fastForward(repoRoot, baseBranch, remote))) {
      throw new SousError(`merge: refusing to merge: ${baseBranch} has diverged from ${remote}/${baseBranch}; reconcile them in ${repoRoot} and run again`);
    }

    const alreadyMerged = !(await git.branchExists(repoRoot, branch)) || (await git.treeSha(repoRoot, branch)) === (await git.treeSha(repoRoot, baseBranch));
    if (inputs["resync"] === true && !alreadyMerged && !(await git.isAncestor(repoRoot, baseBranch, branch))) return undefined;
    const sha = alreadyMerged ? await git.headSha(repoRoot) : await git.squashMerge(repoRoot, branch, message);
    if (remote === undefined) return { sha, alreadyMerged };
    try {
      await git.push(repoRoot, baseBranch, remote);
      return { sha, alreadyMerged };
    } catch (error) {
      return { sha, alreadyMerged, pushError: error instanceof Error ? error.message : String(error) };
    }
  });
  if (landed === undefined) {
    return { summary: `merge: ${baseBranch} moved since the last sync; nothing merged, ${branch} syncs again`, commits: [], output: { stale: true } };
  }
  const { sha, alreadyMerged, pushError } = landed;
  if (remote !== undefined && pushError !== undefined) {
    await ctx.tracker.comment(issue.id, unpushedComment({ baseBranch, sha, message, remote, error: pushError }));
    throw new SousError(`merge: squashed ${branch} into ${baseBranch} as ${sha.slice(0, 7)}, but pushing ${baseBranch} to ${remote} failed: ${pushError}`);
  }
  await cleanUpMerged(ctx);

  const mergedLabel = inputs["mergedLabel"];
  if (typeof mergedLabel === "string" && mergedLabel !== "") await ctx.tracker.setStateLabel(issue.id, mergedLabel);
  await ctx.tracker.comment(issue.id, mergeComment({ baseBranch, sha, message, issue: issue.id, workProgress: ctx.workProgress, minors: minorFindings(await ctx.events.readAll()), ...(remote !== undefined ? { pushedTo: remote } : {}) }));
  if (ctx.work.id === issue.id && ctx.workProgress[issue.id]?.state !== "done") ctx.workDone(alreadyMerged ? [] : [sha]);

  const pushed = remote !== undefined ? `, pushed ${baseBranch} to ${remote}` : "";
  return {
    summary: alreadyMerged ? `merge: ${branch} was already in ${baseBranch} (${sha.slice(0, 7)})${pushed}; cleaned up` : `merge: squashed ${branch} into ${baseBranch} as ${sha.slice(0, 7)}${pushed}`,
    commits: alreadyMerged ? [] : [sha],
    output: { stale: false, sha },
  };
}) satisfies RunFn;
