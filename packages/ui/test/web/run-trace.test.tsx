// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceRow } from "../../server/model";
import { RunTrace, Value } from "../../src/components/RunTrace";

afterEach(cleanup);

const now = Date.parse("2026-10-04T12:10:00.000Z");
const row = (patch: Partial<TraceRow>): TraceRow => ({
  spanId: "r1-1",
  runId: "r1",
  step: "review",
  visit: 1,
  scope: "84",
  status: "success",
  startedAt: "2026-10-04T12:00:00.000Z",
  endedAt: "2026-10-04T12:02:30.000Z",
  next: "fix",
  iterations: 1,
  outputs: [],
  ...patch,
});
const trace = (rows: TraceRow[]) => render(<RunTrace rows={rows} now={now} stepHref={(s) => `/runs/84?step=${s}`} onOpen={() => {}} />);

describe("Value", () => {
  it("draws an object as fields, a list of values inline and a list of objects as a table", () => {
    render(<Value value={{ verdict: "findings", testsRun: ["npm test", "npm run lint"], findings: [{ severity: "major", file: "a.ts", line: 3, message: "wrong" }] }} />);
    expect(screen.getByText("verdict")).toBeTruthy();
    expect(screen.getByText("npm run lint").tagName).toBe("CODE");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["severity", "file", "line", "message"]);
    expect(within(table).getByText("major").style.fontWeight).toBe("600");
  });

  it("says none for an empty list, shortens a sha and clamps long text behind a toggle", () => {
    render(<Value value={{ findings: [], sha: "7e1f00c9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3", log: `line one\n${"x".repeat(300)}` }} />);
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.getByText("7e1f00c").getAttribute("title")).toBe("7e1f00c9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3");
    expect(screen.getByText("line one").closest("details")).not.toBeNull();
  });
});

describe("RunTrace", () => {
  it("has one row per visit with step, visit number, duration, result and next", () => {
    trace([
      row({ spanId: "r1-1", outputs: [{ iteration: 1, summary: "One blocking finding.", output: { verdict: "findings" }, commits: [], eval: { ok: false, logTail: "review: 1 blocking finding" } }] }),
      row({ spanId: "r1-3", visit: 2, next: "merge", outputs: [{ iteration: 1, summary: "Clean.", output: { verdict: "clean" }, commits: ["abcdef1234"], eval: { ok: true, logTail: "" } }] }),
    ]);
    const first = screen.getByTestId("trace-r1-1");
    expect(within(first).getByText("review").getAttribute("href")).toBe("/runs/84?step=review");
    expect(within(first).getByText("2m 30s")).toBeTruthy();
    expect(within(first).getByText("One blocking finding.")).toBeTruthy();
    expect(within(first).getByText("eval failed")).toBeTruthy();
    expect(within(first).getByText("review: 1 blocking finding")).toBeTruthy();
    const second = screen.getByTestId("trace-r1-3");
    expect(within(second).getByText("#2")).toBeTruthy();
    expect(within(second).getByText("merge")).toBeTruthy();
    expect(within(second).getByText("abcdef1")).toBeTruthy();
    expect(screen.queryByText("Work")).toBeNull();
  });

  it("folds earlier iterations, says why an agent was skipped, shows a running visit and a crash", () => {
    trace([
      row({
        spanId: "r1-1",
        step: "implement",
        iterations: 2,
        outputs: [
          { iteration: 1, summary: "first try", output: {}, commits: [], eval: { ok: false, logTail: "1 failed" } },
          { iteration: 2, summary: "second try", output: {}, commits: [], eval: { ok: true, logTail: "" } },
        ],
      }),
      row({ spanId: "r1-2", step: "sync", agentSkipped: { reason: "already up to date" } }),
      (({ next: _next, endedAt: _endedAt, ...open }) => open)(row({ spanId: "r1-3", step: "merge", status: "in_progress" })),
      row({ spanId: "r1-4", step: "fix", status: "failure", error: "agent exited 1", scope: "85" }),
    ]);
    const implement = screen.getByTestId("trace-r1-1");
    expect(within(implement).getByText("2 iterations")).toBeTruthy();
    expect(within(implement).getByText(/iteration 1:/).closest("details")).not.toBeNull();
    expect(within(implement).getByText("second try")).toBeTruthy();
    expect(within(screen.getByTestId("trace-r1-2")).getByText("agent skipped: already up to date")).toBeTruthy();
    expect(within(screen.getByTestId("trace-r1-3")).getByText("running…")).toBeTruthy();
    expect(within(screen.getByTestId("trace-r1-3")).getByText("10m 0s")).toBeTruthy();
    expect(within(screen.getByTestId("trace-r1-4")).getByText("agent exited 1")).toBeTruthy();
    // Two work items: the work column appears.
    expect(screen.getByText("Work")).toBeTruthy();
    expect(within(screen.getByTestId("trace-r1-4")).getByText("#85")).toBeTruthy();
  });

  it("says so before any step ran", () => {
    trace([]);
    expect(screen.getByText("No step has run yet.")).toBeTruthy();
  });
});
