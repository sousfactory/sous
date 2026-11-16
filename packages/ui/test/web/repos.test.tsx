// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepDetail, StepNode } from "../../server/model";
import { useGitHubView } from "../../src/components/GitHubActionsCell";
import { StepView } from "../../src/components/StepView";
import { LiveProvider, useVersion } from "../../src/live";

/** Over `repos:` the same issue id lives in two repositories: every request of a run page names its repository. */

let fetched: string[];

beforeEach(() => {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, headers: new Headers(), text: async () => "", json: async () => ({ state: "none" }) };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const node: StepNode = { id: "review", status: "success", visits: 1, uses: "review" };

const detail: StepDetail = {
  id: "review",
  routes: [],
  visits: [
    {
      spanId: "r1-3",
      runId: "r1",
      scope: "84",
      startedAt: "2026-10-04T12:00:00.000Z",
      endedAt: "2026-10-04T12:01:00.000Z",
      next: "done",
      status: "success",
      costUnknown: 0,
      cost: "",
      iterations: [{ n: 1, agent: { kind: "claude", model: "claude-opus-5-5", startedAt: "2026-10-04T12:00:00.000Z", endedAt: "2026-10-04T12:00:40.000Z", outcome: "ok", commits: [], log: "review-1.log", cost: "" } }],
    },
  ],
};

describe("a run page of a listed repository", () => {
  it("opens an agent log through ?repo=, and without a repository as before", async () => {
    render(<StepView issue="84" repo="api" node={node} detail={detail} now={Date.parse("2026-10-04T12:10:00.000Z")} live={false} />);
    fireEvent.click(screen.getByTestId("agent-1-1").querySelector("button")!);
    await waitFor(() => expect(fetched).toEqual(["/api/runs/84/logs/review-1.log?repo=api&from=0"]));
    cleanup();

    fetched = [];
    render(<StepView issue="84" node={node} detail={detail} now={Date.parse("2026-10-04T12:10:00.000Z")} live={false} />);
    fireEvent.click(screen.getByTestId("agent-1-1").querySelector("button")!);
    await waitFor(() => expect(fetched).toEqual(["/api/runs/84/logs/review-1.log?from=0"]));
  });

  it("asks for the GitHub Actions view of the run in its own repository", async () => {
    const Probe = () => {
      useGitHubView("84", "api");
      return null;
    };
    render(<Probe />);
    await waitFor(() => expect(fetched).toEqual(["/api/runs/84/github?repo=api"]));
  });
});

describe("live versions over repos:", () => {
  type Listener = (event: MessageEvent<string>) => void;
  let source: { listeners: Map<string, Listener[]> } | undefined;

  beforeEach(() => {
    source = undefined;
    vi.stubGlobal(
      "EventSource",
      class {
        listeners = new Map<string, Listener[]>();
        constructor() {
          source = this;
        }
        addEventListener(type: string, listener: Listener) {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        close() {}
      },
    );
  });

  const change = (data: object) =>
    act(() => {
      for (const listener of source?.listeners.get("change") ?? []) listener(new MessageEvent("change", { data: JSON.stringify(data) }));
    });

  it("moves the version of an issue in the repository the change names, not the same issue id in another", () => {
    const Versions = () => (
      <>
        <span data-testid="web">{useVersion("7", "web")}</span>
        <span data-testid="api">{useVersion("7", "api")}</span>
        <span data-testid="plain">{useVersion("7")}</span>
      </>
    );
    render(
      <LiveProvider>
        <Versions />
      </LiveProvider>,
    );
    const read = () => ["web", "api", "plain"].map((id) => screen.getByTestId(id).textContent);
    expect(read()).toEqual(["0:0", "0:0", "0:0"]);

    change({ issue: "7", repo: "api" });
    expect(read()).toEqual(["0:0", "0:1", "0:0"]);

    change({ issue: "7" });
    expect(read()).toEqual(["0:0", "0:1", "0:1"]);

    change({ issue: null });
    expect(read()).toEqual(["1:0", "1:1", "1:1"]);
  });
});
