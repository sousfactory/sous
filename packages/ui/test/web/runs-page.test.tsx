// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunsResponse } from "../../server/api";
import { RunsPage } from "../../src/pages/RunsPage";

afterEach(cleanup);

const data: RunsResponse = {
  repo: "example-repo",
  flows: ["feature", "task"],
  live: [],
  rows: [
    {
      kind: "run",
      updatedAt: "2026-10-04T12:05:00.000Z",
      summary: { issue: "84", title: "shorten the KDoc", flow: "task", branch: "feature/84-shorten", status: "success", outcome: "done", live: false, attempts: 1, runId: "e1df38b7", sha: "790cc89", startedAt: "2026-10-04T12:00:00.000Z", endedAt: "2026-10-04T12:04:32.000Z" },
    },
    { kind: "error", updatedAt: "2026-10-03T12:00:00.000Z", issue: "68", error: "/schemaVersion must be equal to constant" },
  ],
};

describe("RunsPage", () => {
  it("shows a row per issue with status, flow, run, branch and duration", () => {
    render(<RunsPage data={data} error={undefined} flow={undefined} />);
    expect(screen.getByText("2 flow runs")).toBeTruthy();
    const row = screen.getByTestId("run-row");
    expect(row.querySelector("[data-status]")?.getAttribute("data-status")).toBe("success");
    expect(row.textContent).toContain("shorten the KDoc");
    expect(row.textContent).toContain("task 84: Run e1df38b7 started by sous run at 790cc89");
    expect(row.textContent).toContain("feature/84-shorten");
    expect(row.textContent).toContain("4m 32s");
    expect(screen.getByRole("link", { name: "shorten the KDoc" }).getAttribute("href")).toBe("/runs/84");
  });

  it("greys an unreadable run folder and says why", () => {
    render(<RunsPage data={data} error={undefined} flow={undefined} />);
    const row = screen.getByTestId("run-row-error");
    expect(row.textContent).toContain("Run folder 68");
    expect(row.textContent).toContain("/schemaVersion must be equal to constant");
  });

  it("filters by flow", () => {
    render(<RunsPage data={data} error={undefined} flow="feature" />);
    expect(screen.getByText("0 flow runs")).toBeTruthy();
    expect(screen.queryByTestId("run-row")).toBeNull();
  });
});
