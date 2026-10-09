import { describe, expect, it } from "vitest";
import { elapsed, formatCount, formatDuration, timeAgo } from "../../src/format";
import { hrefOf, parseRoute } from "../../src/router";

describe("formatDuration", () => {
  it("writes durations as GitHub does", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(273_000)).toBe("4m 33s");
    expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("measures to now while there is no end", () => {
    const start = "2026-10-04T12:00:00.000Z";
    expect(elapsed(start, "2026-10-04T12:01:30.000Z", 0)).toBe("1m 30s");
    expect(elapsed(start, undefined, Date.parse("2026-10-04T12:00:07.000Z"))).toBe("7s");
    expect(elapsed(undefined, undefined, 0)).toBeUndefined();
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  it("rounds down to the largest unit", () => {
    expect(timeAgo("2026-10-04T11:59:30.000Z", now)).toBe("now");
    expect(timeAgo("2026-10-04T11:59:00.000Z", now)).toBe("1 minute ago");
    expect(timeAgo("2026-10-04T09:30:00.000Z", now)).toBe("2 hours ago");
    expect(timeAgo("2026-10-03T10:00:00.000Z", now)).toBe("yesterday");
    expect(timeAgo("2026-09-30T12:00:00.000Z", now)).toBe("4 days ago");
  });
});

describe("formatCount", () => {
  it("abbreviates thousands", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_345)).toBe("12k");
    expect(formatCount(1_250)).toBe("1.3k");
  });
});

describe("routes", () => {
  it("parses and writes the three routes", () => {
    expect(parseRoute("/", "")).toEqual({ page: "runs" });
    expect(parseRoute("/runs", "?flow=task")).toEqual({ page: "runs", flow: "task" });
    expect(parseRoute("/runs/84", "?attempt=2&scope=51&step=review")).toEqual({ page: "run", issue: "84", attempt: 2, scope: "51", step: "review" });
    expect(parseRoute("/runs/84", "?attempt=x")).toEqual({ page: "run", issue: "84" });
    expect(hrefOf({ page: "run", issue: "84", step: "review-full" })).toBe("/runs/84?step=review-full");
    expect(hrefOf({ page: "runs", flow: "task" })).toBe("/runs?flow=task");
    expect(parseRoute("/runs", "?flow=task&step=review")).toEqual({ page: "runs", flow: "task", step: "review" });
    expect(parseRoute("/runs", "?step=review")).toEqual({ page: "runs" });
    expect(hrefOf({ page: "runs", flow: "task", step: "review-full" })).toBe("/runs?flow=task&step=review-full");
  });
});
