/**
 * The prompts sous sends to an agent. The retry and invalid-output prompts
 * are shared by every agentic step on purpose; steps cannot override them,
 * so the envelope rules stay the same everywhere.
 */
import type { Step } from "../config/step.js";
import { renderPlaceholders, type CtxValues } from "../expr/compile.js";
import type { Inputs } from "../index.js";
import { SKILLS_CONTRACT, SKILLS_CONTRACT_LINE } from "../skills.js";

/** Appended to every agentic prompt, so the agent knows the `<result>` envelope and the step's output schema. */
export const outputContract = (output: Record<string, unknown>): string =>
  [
    "## Output contract",
    "",
    "Finish your final message with exactly one block of this form, JSON only",
    "inside the tags, no code fences:",
    "",
    "<result>{",
    '  "summary": "two to five sentences on what you did and what you left open",',
    '  "commits": ["full sha of every commit you made, oldest first"],',
    '  "output": <value matching the JSON Schema below>,',
    SKILLS_CONTRACT_LINE,
    "}</result>",
    "",
    SKILLS_CONTRACT,
    "",
    JSON.stringify(output, null, 2),
  ].join("\n");

/**
 * Appended to the step's prompt when the eval ran before the agent and
 * failed: after `prepare` said `on-fail`, or on a re-entry without a session
 * to resume. The agent starts fresh, so the log travels in its first message.
 */
export const failedEvalSection = (log: string): string =>
  [
    "## The evaluation already ran",
    "",
    "This step's evaluation ran before you, on the worktree as it is now, and",
    "did not pass. Its output:",
    "",
    "```",
    log.trimEnd(),
    "```",
    "",
    "Fix the cause, then follow the instructions above and answer with the",
    "result block below.",
  ].join("\n");

/**
 * An optional input the flow did not wire renders empty; a required one is
 * guaranteed by `validate`. `prepared` is what the visit's `prepare` returned.
 * `failedEval` is the log of an eval that ran before this agent call and
 * failed; it goes between the step's text and the output contract.
 */
export const renderPrompt = (step: Step, inputs: Inputs, ctx: CtxValues, prepared?: unknown, failedEval?: string): string => {
  if (step.run?.kind !== "prompt") throw new Error(`${step.name} is deterministic; it has no prompt`);
  const filled: Inputs = { ...Object.fromEntries(Object.keys(step.inputs).map((name) => [name, ""])), ...inputs };
  const body = renderPlaceholders(step.run.prompt, filled, ctx, prepared).trimEnd();
  const sections = [body, ...(failedEval !== undefined ? [failedEvalSection(failedEval)] : []), outputContract(step.run.output)];
  return `${sections.join("\n\n")}\n`;
};

/** Sent in the visit's own session after a failed eval, with the eval log. */
export const retryPrompt = (log: string): string =>
  [
    "The previous attempt did not pass evaluation. Output:",
    "",
    "```",
    log.trimEnd(),
    "```",
    "",
    "Fix it, re-run the checks, commit, and answer again with the same",
    "`<result>{ … }</result>` block as before (summary, commits, output, skills).",
    "The rules of the original instructions still apply: current branch only,",
    "no push, clean working tree before answering.",
  ].join("\n");

export type OutputFailure = {
  reason: string;
  /** Undefined when no `<result>` tag was emitted. */
  rawMatched: string | undefined;
};

/** Sent in the same session when the output did not validate; asks for the envelope only, no new work. */
export const invalidOutputPrompt = (failure: OutputFailure): string =>
  [
    `Your output did not validate: ${failure.reason}.`,
    failure.rawMatched === undefined ? "No <result> block was found." : `Matched block:\n${failure.rawMatched.trim()}`,
    "Do not change files or run commands. Answer again with only a corrected <result>{ … }</result> block matching the schema in the original instructions.",
  ].join("\n\n");
