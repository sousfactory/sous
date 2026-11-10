/**
 * The run header's total: how long the run took and what its agent calls
 * cost. The cost is the server's rendering of the timeline fold, the string
 * `sous status` prints; a `+` marks a lower bound and says on hover how many
 * calls reported no cost. A run without a costed call shows no figure.
 */
import type { RunSummary } from "../../server/model";
import { elapsed } from "../format";

export type RunTotalProps = { summary: Pick<RunSummary, "startedAt" | "endedAt" | "costUsd" | "costUnknown" | "cost">; now: number };

export const RunTotal = ({ summary, now }: RunTotalProps) => {
  const uncosted = summary.costUnknown;
  const title = uncosted > 0 ? `${uncosted} agent call${uncosted === 1 ? "" : "s"} reported no cost` : undefined;
  return (
    <span className="tabular-nums" data-testid="run-total">
      {elapsed(summary.startedAt, summary.endedAt, now) ?? "–"}
      {summary.cost !== "" ? (
        <>
          {" · "}
          <span data-testid="run-cost" {...(title !== undefined ? { title } : {})}>
            {summary.cost}
          </span>
        </>
      ) : null}
    </span>
  );
};
