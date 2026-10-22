/**
 * The spec is on the branch and leaves nothing to the human. A missing file
 * or uncommitted work after the agent fails; questions under
 * `## Open questions` fail with the questions as the log, which becomes the
 * blocked comment: the human answers them in the file (or in the issue) and
 * runs the issue again, and this eval judges the answered file first.
 */
import { readFile } from "node:fs/promises";
import type { Ctx, Envelope, EvalFn, Inputs } from "sous-factory";
import { specFile } from "./prepare.js";

/** The list items of the `## <heading>` section, up to the next `## ` heading; none without the section. */
export const sectionItems = (text: string, heading: string): string[] => {
  const pattern = new RegExp(`(?:^|\\n)##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const section = text.match(pattern)?.[1] ?? "";
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+\S/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, ""));
};

export default (async (ctx: Ctx, _inputs: Inputs = {}, result?: Envelope) => {
  const file = specFile(ctx);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { ok: false, log: `plan: no ${ctx.specDir}/spec.md in the worktree; the spec must be written and committed there` };
  }
  if (result !== undefined && (await ctx.git.isDirty(ctx.worktree))) {
    return { ok: false, log: `plan: the worktree has uncommitted changes; commit ${ctx.specDir}/spec.md on the branch` };
  }
  const questions = sectionItems(text, "Open questions");
  const assumptions = sectionItems(text, "Assumptions");
  if (questions.length > 0) {
    return {
      ok: false,
      log: [
        `plan: ${ctx.specDir}/spec.md leaves ${questions.length} question${questions.length === 1 ? "" : "s"} open. Answer them in the file (or in the issue body) and run the issue again:`,
        ...questions.map((q) => `- ${q}`),
      ].join("\n"),
    };
  }
  return { ok: true, log: `plan: ${ctx.specDir}/spec.md is on the branch with ${assumptions.length} assumption${assumptions.length === 1 ? "" : "s"} and no open questions` };
}) satisfies EvalFn;
