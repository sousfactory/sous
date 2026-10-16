/**
 * The project's checks, eval-only. This file is the project's own: put the
 * commands in `CHECKS` and the base branch in `BASE_BRANCH`, nothing else
 * needs to know them. A check with `when` runs only when the branch's diff
 * against the base branch touches that folder, to keep unrelated runs fast.
 * Stops at the first failure; the log is a transcript per command. An empty
 * list passes with a WARN line in the log, so a project that has not filled
 * it in yet sees that in `sous status` and the UI.
 */
import { join } from "node:path";
import type { Ctx, EvalFn, EvalResult } from "sous-factory";

/** One command; `dir` is relative to the worktree (its root when absent); `when` is a folder the diff must touch for the check to run. */
export type Check = { command: string; dir?: string; when?: string };

// TODO: the branch runs fork from and the diff is taken against (the `baseBranch` setting).
export const BASE_BRANCH = "main";

// TODO: put the project's checks here, in the order to run them; examples:
//   { command: "npm test" },
//   { command: "./gradlew clean build" },
//   { command: "cargo test" },
//   { command: "npx tsc --noEmit", dir: "web", when: "web" },
export const CHECKS: readonly Check[] = [];

export const NO_CHECKS_WARNING = "WARN: no checks configured; put the project's checks in steps/verify/eval.ts";

const touches = (paths: readonly string[], dir: string): boolean => paths.some((p) => p === dir || p.startsWith(`${dir}/`));

/** The checks the changed paths call for: every unconditional one, plus those whose `when` folder is touched. */
export const checksFor = (checks: readonly Check[], changed: readonly string[]): Check[] => checks.filter((c) => c.when === undefined || touches(changed, c.when));

/** `$ <command> (exit <code>)` with the output under it; a command run elsewhere than the worktree root shows its `cd`. */
const transcript = (check: Check, out: { code: number; stdout: string; stderr: string }): string =>
  `$ ${check.dir !== undefined ? `cd ${check.dir} && ` : ""}${check.command} (exit ${out.code})\n${out.stdout}${out.stderr}`.trimEnd();

/** Runs `checks` in order in the worktree, stopping at the first failure. */
export const runChecks = async (ctx: Pick<Ctx, "exec" | "worktree">, checks: readonly Check[]): Promise<EvalResult> => {
  const log: string[] = [];
  for (const check of checks) {
    const out = await ctx.exec(check.command, check.dir !== undefined ? { cwd: join(ctx.worktree, check.dir) } : {});
    log.push(transcript(check, out));
    if (out.code !== 0) return { ok: false, log: log.join("\n") };
  }
  return { ok: true, log: log.join("\n") };
};

export const diffCommand = (baseBranch: string): string => `git diff --name-only ${baseBranch}...HEAD`;

const verify: EvalFn = async (ctx) => {
  if (CHECKS.length === 0) return { ok: true, log: NO_CHECKS_WARNING };
  const diff = diffCommand(BASE_BRANCH);
  const out = await ctx.exec(diff);
  if (out.code !== 0) return { ok: false, log: transcript({ command: diff }, out) };
  const changed = out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return runChecks(ctx, checksFor(CHECKS, changed));
};

export default verify;
