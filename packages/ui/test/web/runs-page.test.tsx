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
      summary: { issue: "84", title: "shorten the KDoc", flow: "task", branch: "feature/84-shorten", status: "success", outcome: "done", live: false, attempts: 1, runId: "e1df38b7", sha: "790cc89", startedAt: "2026-10-04T12:00:00.000Z", endedAt: "2026-10-04T12:04:32.000Z", costUnknown: 0, cost: "" },
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

  it("names each row's repository in a column over repos:, and links the run in it", () => {
    const tag = (folder: string) => ({ name: folder, folder });
    const run = data.rows[0]!;
    const repos: RunsResponse = {
      ...data,
      rows: [
        { ...run, repo: tag("web") } as RunsResponse["rows"][number],
        { ...run, updatedAt: "2026-10-04T12:04:00.000Z", repo: tag("api") } as RunsResponse["rows"][number],
        { kind: "error", updatedAt: "2026-10-03T12:00:00.000Z", issue: "70", error: "/schemaVersion must be equal to constant", schema: { found: 4, expected: 9 }, title: "old run", flow: "task", repo: tag("web") },
      ],
    };
    render(<RunsPage data={repos} error={undefined} flow={undefined} />);
    expect(screen.getAllByTestId("run-repo").map((c) => c.textContent)).toEqual(["web", "api", "web"]);
    expect(screen.getAllByRole("link", { name: "shorten the KDoc" }).map((a) => a.getAttribute("href"))).toEqual(["/runs/84?repo=web", "/runs/84?repo=api"]);
    const foreign = screen.getByTestId("run-row-error");
    expect(foreign.textContent).toContain("old run");
    expect(foreign.textContent).toContain("task 70");
    expect(foreign.textContent).toContain("70: unreadable, session schema version 4; this sous ui reads 9");
  });

  it("lists a repository whose sous.yaml this sous ui cannot read as one row naming it and why", () => {
    const repos: RunsResponse = {
      ...data,
      rows: [{ kind: "error", settings: true, updatedAt: "2026-10-04T12:00:00.000Z", issue: "", error: "/ must NOT have additional properties (fromTheFuture)", repo: { name: "api", folder: "api" } }],
    };
    render(<RunsPage data={repos} error={undefined} flow={undefined} />);
    const row = screen.getByTestId("run-row-error");
    expect(row.textContent).toContain("Repository api");
    expect(row.textContent).toContain("this sous ui cannot read its .sous/sous.yaml: / must NOT have additional properties (fromTheFuture)");
  });

  it("has no repository column without repos:", () => {
    render(<RunsPage data={data} error={undefined} flow={undefined} />);
    expect(screen.queryByTestId("run-repo")).toBeNull();
  });

  it("filters by flow", () => {
    render(<RunsPage data={data} error={undefined} flow="feature" />);
    expect(screen.getByText("0 flow runs")).toBeTruthy();
    expect(screen.queryByTestId("run-row")).toBeNull();
  });
});
