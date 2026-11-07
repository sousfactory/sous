/**
 * A `run: { shell }` step: the command's environment and the envelope made
 * from what it printed. Inputs reach the command as variables, never as
 * text in the command line, so a value can never become shell syntax.
 */
import { stringify } from "../expr/compile.js";
import type { Ctx, Envelope, ExecResult, Inputs } from "../index.js";

/** `diffRange` → `SOUS_INPUT_DIFF_RANGE`, `input_kind` → `SOUS_INPUT_INPUT_KIND`. */
export const inputEnvName = (input: string): string => `SOUS_INPUT_${input.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

/**
 * One variable per input with a value (an unwired optional input is absent,
 * not empty, so the command can test for it), stringified as a template
 * renders it, plus the run's facts.
 */
export const shellEnv = (ctx: Ctx, inputs: Inputs): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(inputs)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [inputEnvName(name), stringify(value)]),
  ),
  SOUS_WORKTREE: ctx.worktree,
  SOUS_REPO_ROOT: ctx.repoRoot,
  SOUS_SPEC_DIR: ctx.specDir,
  SOUS_BRANCH: ctx.branch,
  SOUS_BASE_BRANCH: ctx.baseBranch,
  SOUS_ISSUE_ID: ctx.issue.id,
  SOUS_ISSUE_REF: ctx.issue.ref,
  SOUS_WORK_ID: ctx.work.id,
  SOUS_WORK_REF: ctx.work.ref,
});

/** What a shell step's `result.output` is: always the three fields, `json` only when the whole of stdout parses. */
export type ShellOutput = { stdout: string; stderr: string; code: number; json?: unknown };

const parsed = (stdout: string): { json: unknown } | undefined => {
  if (stdout.trim() === "") return undefined;
  try {
    return { json: JSON.parse(stdout) as unknown };
  } catch {
    return undefined;
  }
};

/** A non-zero exit is a fact in `code`, not a failure: the eval and the routes decide. */
export const shellEnvelope = (command: string, out: ExecResult): Envelope => {
  const output: ShellOutput = { stdout: out.stdout, stderr: out.stderr, code: out.code, ...parsed(out.stdout) };
  return { summary: command, commits: [], output };
};
