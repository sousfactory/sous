/**
 * Routes on the agent's verdict about the issue. `holds` and `unclear` pass:
 * ambiguity resolves toward going on. `fixed` and `false-premise` fail with
 * the commands the agent ran and their results as the log, which becomes
 * the blocked comment the human closes or rewrites the issue on; the run
 * never does that itself. A blocking verdict without evidence, or an output
 * that is no verdict at all, fails too: a check that did not happen never
 * counts as `holds`. `loop: false` sends every failure to the flow's route.
 */
import type { Ctx, Envelope, EvalFn, Inputs, Prepared } from "sous-factory";
import type { CheckIssuePrepared } from "./prepare.js";

export const VERDICTS = ["holds", "fixed", "false-premise", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Evidence = { command: string; result: string };

const BLOCKING: Partial<Record<Verdict, string>> = {
  fixed: "the defect it describes is gone from the code. Close the issue on this evidence, or correct it and run it again.",
  "false-premise": "what it claims is not what the code shows. Close or rewrite the issue on this evidence, and run it again.",
};

const isVerdict = (value: unknown): value is Verdict => (VERDICTS as readonly unknown[]).includes(value);

const isEvidence = (value: unknown): value is Evidence[] =>
  Array.isArray(value) &&
  value.every((e: unknown) => typeof e === "object" && e !== null && typeof (e as Evidence).command === "string" && typeof (e as Evidence).result === "string");

const formatEvidence = (evidence: Evidence[]): string[] => evidence.flatMap((e) => [`$ ${e.command}`, e.result.trimEnd()]);

export default (async (ctx: Ctx, _inputs: Inputs = {}, result?: Envelope, prepared?: Prepared) => {
  const ref = ctx.work.ref;
  if ((prepared?.output as CheckIssuePrepared | undefined)?.verdict === "closed") return { ok: false, log: `check-issue: ${ref} is closed; nothing to check or build` };
  if (result === undefined) return { ok: false, log: "check-issue: no check output" };
  const output = (result.output ?? {}) as { verdict?: unknown; evidence?: unknown };
  if (!isVerdict(output.verdict)) return { ok: false, log: `check-issue: the output has no verdict of ${VERDICTS.slice(0, -1).join(", ")} or ${VERDICTS.at(-1)}` };
  if (!isEvidence(output.evidence)) return { ok: false, log: "check-issue: the evidence is not a list of { command, result }" };
  const { verdict, evidence } = output;
  const blocking = BLOCKING[verdict];
  if (blocking !== undefined) {
    if (evidence.length === 0) return { ok: false, log: `check-issue: the verdict ${verdict} comes without evidence; it needs each command run and its result` };
    return { ok: false, log: [`check-issue: ${ref} no longer holds (${verdict}): ${blocking}`, ...formatEvidence(evidence)].join("\n") };
  }
  const head = verdict === "holds" ? `check-issue: ${ref} holds against the code` : `check-issue: ${ref} is unclear against the code; the run goes on`;
  return { ok: true, log: [head, ...formatEvidence(evidence)].join("\n") };
}) satisfies EvalFn;
