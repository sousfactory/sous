/**
 * Squashes the branch into the base-branch checkout, cleans up, labels the
 * issue and comments the result. Closing the issue is the run's lifecycle
 * (`lifecycle: core` closes it on `done`). Never pushes. Idempotent so a
 * rerun after a crash neither squashes twice nor fails on what is already
 * removed.
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
  sha: string;
  message: string;
  /** The run target's id; its own progress entry is the run itself and is not listed. */
  issue: string;
  workProgress: Readonly<Record<string, WorkRecord>>;
  minors: readonly Finding[];
};

export const mergeComment = ({ baseBranch, sha, message, issue, workProgress, minors }: MergeSummary): string => {
  const entries = Object.entries(workProgress).filter(([id]) => id !== issue);
  return [
    `Merged into \`${baseBranch}\` as ${sha.slice(0, 7)}: \`${message}\``,
    ...(entries.length > 0 ? ["", "Sub-issues:", ...entries.map(([id, r]) => `- ${id}: ${r.state}, ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}`)] : []),
    ...(minors.length > 0 ? ["", "Minor review findings (logged, not fixed):", ...minors.map((f) => `- ${formatFinding(f)}`)] : []),
  ].join("\n");
};

/** Close the sandbox, remove the worktree and delete the branch; each may already be gone. */
export const cleanUpMerged = async (ctx: Pick<Ctx, "git" | "sandbox" | "repoRoot" | "worktree" | "branch">): Promise<void> => {
  await ctx.sandbox.close();
  await ctx.git.removeWorktree(ctx.repoRoot, ctx.worktree);
  if (await ctx.git.branchExists(ctx.repoRoot, ctx.branch)) await ctx.git.deleteBranch(ctx.repoRoot, ctx.branch, { force: true });
};

export default (async (ctx, inputs) => {
  const baseBranch = requireString(inputs, "baseBranch", "merge");
  const { git, repoRoot, branch, issue } = ctx;

  const checkedOut = await git.currentBranch(repoRoot);
  if (checkedOut !== baseBranch) throw new SousError(`merge: refusing to merge: ${repoRoot} has ${checkedOut} checked out, not ${baseBranch}`);
  if (await git.isDirty(repoRoot)) throw new SousError(`merge: refusing to merge: the ${baseBranch} checkout at ${repoRoot} has uncommitted changes`);

  const message = mergeMessage(issue);
  const alreadyMerged = !(await git.branchExists(repoRoot, branch)) || (await git.treeSha(repoRoot, branch)) === (await git.treeSha(repoRoot, baseBranch));
  const sha = alreadyMerged ? await git.headSha(repoRoot) : await git.squashMerge(repoRoot, branch, message);
  await cleanUpMerged(ctx);

  const mergedLabel = inputs["mergedLabel"];
  if (typeof mergedLabel === "string" && mergedLabel !== "") await ctx.tracker.setStateLabel(issue.id, mergedLabel);
  await ctx.tracker.comment(issue.id, mergeComment({ baseBranch, sha, message, issue: issue.id, workProgress: ctx.workProgress, minors: minorFindings(await ctx.events.readAll()) }));
  if (ctx.work.id === issue.id && ctx.workProgress[issue.id]?.state !== "done") ctx.workDone(alreadyMerged ? [] : [sha]);

  return {
    summary: alreadyMerged ? `merge: ${branch} was already in ${baseBranch} (${sha.slice(0, 7)}); cleaned up` : `merge: squashed ${branch} into ${baseBranch} as ${sha.slice(0, 7)}`,
    commits: alreadyMerged ? [] : [sha],
    output: { sha },
  };
}) satisfies RunFn;
