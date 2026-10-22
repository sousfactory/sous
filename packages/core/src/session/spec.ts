/**
 * The spec a run works from. The plan phase commits `spec.md` into the spec
 * folder on the base branch, or on the issue's branch while its run is
 * blocked; a run reads it from its worktree at every start and never writes
 * one. Without a file the issue itself is the spec: its title and body,
 * nothing invented.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SpecSource = "file" | "issue";

export type Spec = {
  /** The full markdown handed to steps as `ctx.spec`. */
  text: string;
  source: SpecSource;
};

/** The issue as a spec: a title line and the body as filed. */
export const specFromIssue = (issue: { ref: string; title: string; body: string }): string => {
  const body = issue.body.trim();
  return `# ${issue.title}\n\n${body.length > 0 ? body : `_Issue ${issue.ref} has no description._`}\n`;
};

/**
 * `<worktree>/<specDir>/spec.md` as it is on disk, committed or not, else
 * the issue. The worktree is read as it stands, so an edit made there while
 * the run was blocked counts.
 */
export const readSpec = (worktree: string, specDir: string, issue: { ref: string; title: string; body: string }): Spec => {
  try {
    return { text: readFileSync(join(worktree, specDir, "spec.md"), "utf8"), source: "file" };
  } catch {
    return { text: specFromIssue(issue), source: "issue" };
  }
};
