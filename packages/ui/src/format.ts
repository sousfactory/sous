/** Durations and times the way GitHub Actions writes them. */

/** `12s`, `4m 33s`, `1h 2m 5s`; negative or missing time is `0s`. */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

/** Duration from `start` to `end`, or to `now` while there is no end. */
export const elapsed = (start: string | undefined, end: string | undefined, now: number): string | undefined =>
  start === undefined ? undefined : formatDuration((end !== undefined ? Date.parse(end) : now) - Date.parse(start));

const UNITS: [number, string][] = [
  [365 * 24 * 3600, "year"],
  [30 * 24 * 3600, "month"],
  [7 * 24 * 3600, "week"],
  [24 * 3600, "day"],
  [3600, "hour"],
  [60, "minute"],
];

/** `now`, `5 minutes ago`, `yesterday`, `3 days ago`. */
export const timeAgo = (iso: string, now: number): string => {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  for (const [size, unit] of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) {
      if (unit === "day" && n === 1) return "yesterday";
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "now";
};

/** `12.3k` style token counts. */
export const formatCount = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export const shortSha = (sha: string): string => sha.slice(0, 7);
