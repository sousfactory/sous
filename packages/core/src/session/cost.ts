/**
 * How a cost reads wherever a run is shown, in `sous status` and `sous ui`
 * alike, so the two never disagree.
 */

/**
 * `$3.50`, `$3.50+` when `unknown` agent calls reported no cost (the figure
 * is a lower bound), `<$0.01` for a positive amount that would round to
 * zero, and an empty string when no cost is known, so an unknown never reads
 * as a free call.
 */
export const formatCost = (usd: number | undefined, unknown: number): string => {
  if (usd === undefined) return "";
  const amount = usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`;
  return unknown > 0 ? `${amount}+` : amount;
};
