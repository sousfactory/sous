// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StepDetail, StepNode } from "../../server/model";
import { focusOf } from "../../src/components/FlowGraph";
import { actionsStatus, GitHubActions } from "../../src/components/GitHubActionsCell";
import { StatusIcon } from "../../src/components/StatusIcon";
import { shortModel, StepCard } from "../../src/components/StepCard";
import { StepView } from "../../src/components/StepView";

afterEach(cleanup);

const now = Date.parse("2026-10-04T12:10:00.000Z");
const node = (patch: Partial<StepNode> = {}): StepNode => ({ id: "review", status: "success", visits: 1, uses: "review", ...patch });

describe("StatusIcon", () => {

  it("labels every status for assistive technology", () => {
    for (const [status, label] of [
      ["success", "Success"],
      ["failure", "Failure"],
      ["in_progress", "In progress"],
      ["queued", "Queued"],
      ["skipped", "Skipped"],
      ["cancelled", "Cancelled"],
    ] as const) {
      render(<StatusIcon status={status} />);
      expect(screen.getByRole("img", { name: label }).getAttribute("data-status")).toBe(status);
      cleanup();
    }
  });
});

describe("GitHubActions", () => {
  const SHA = "b2f04a5d78df04f2adc77a062964d5bcb15f2024";

  it("maps GitHub's status and conclusion onto the page's statuses", () => {
    expect(actionsStatus({ status: "queued" })).toBe("queued");
    expect(actionsStatus({ status: "in_progress" })).toBe("in_progress");
    expect(actionsStatus({ status: "completed", conclusion: "success" })).toBe("success");
    expect(actionsStatus({ status: "completed", conclusion: "timed_out" })).toBe("failure");
    expect(actionsStatus({ status: "completed", conclusion: "cancelled" })).toBe("cancelled");
    expect(actionsStatus({ status: "completed", conclusion: "skipped" })).toBe("skipped");
  });

  it("links every workflow run with its status", () => {
    render(
      <GitHubActions
        view={{
          state: "runs",
          sha: SHA,
          final: false,
          runs: [
            { workflow: "deploy-ec2", url: "https://github.com/o/r/actions/runs/1", status: "completed", conclusion: "success" },
            { workflow: "infra-deploy", url: "https://github.com/o/r/actions/runs/2", status: "in_progress" },
          ],
        }}
      />,
    );
    const deploy = screen.getByRole("link", { name: /deploy-ec2/ });
    expect(deploy.getAttribute("href")).toBe("https://github.com/o/r/actions/runs/1");
    expect(deploy.getAttribute("target")).toBe("_blank");
    expect(deploy.title).toBe("deploy-ec2: Success");
    expect(screen.getByRole("link", { name: /infra-deploy/ }).title).toBe("infra-deploy: In progress");
  });

  it("says why there is no run: not pushed, no workflow (with the commit link), or gh unavailable", () => {
    render(<GitHubActions view={{ state: "unpushed", sha: SHA }} />);
    expect(screen.getByText(/not pushed yet/).textContent).toContain("b2f04a5");
    cleanup();
    render(<GitHubActions view={{ state: "no-workflow", sha: SHA, commitUrl: `https://github.com/o/r/commit/${SHA}` }} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(`https://github.com/o/r/commit/${SHA}`);
    cleanup();
    render(<GitHubActions view={{ state: "unavailable", sha: SHA, error: "gh auth login" }} />);
    expect(screen.getByText("GitHub unavailable").title).toBe("gh auth login");
  });
});

describe("focusOf", () => {
  const edges = [
    { from: "init", to: "implement" },
    { from: "implement", to: "review" },
    { from: "review", to: "fix" },
    { from: "fix", to: "review" },
    { from: "review", to: "merge" },
  ];

  it("leaves everything plain without a hovered card", () => {
    const f = focusOf(undefined, edges);
    expect(f.node("review")).toBeUndefined();
    expect(f.edge(edges[0]!)).toBeUndefined();
  });

  it("lights the hovered card, its direct neighbours and the routes that touch it; the rest fades", () => {
    const f = focusOf("implement", edges);
    expect(["init", "implement", "review", "fix", "merge"].map(f.node)).toEqual(["on", "on", "on", "off", "off"]);
    expect(edges.map(f.edge)).toEqual(["on", "on", "off", "off", "off"]);
  });
});

describe("StepCard", () => {
  it("carries its full name in a tooltip that CSS shows on hover", () => {
    render(<StepCard node={node({ id: "fix-review-full" })} now={now} flow="task" />);
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(tip.textContent).toBe("fix-review-full");
    expect(tip.className).toBe("sous-tip");
    expect(tip.parentElement?.className).toContain("sous-tip-host");
  });

  it("shows name, latest-visit duration, visit badge and model chip", () => {
    render(
      <StepCard
        node={node({ visits: 3, agent: { kind: "claude", model: "claude-opus-5-5" }, startedAt: "2026-10-04T12:00:00.000Z", endedAt: "2026-10-04T12:02:05.000Z" })}
        now={now}
        flow="task"
      />,
    );
    const card = screen.getByTestId("step-review");
    expect(card.textContent).toContain("review");
    expect(card.textContent).toContain("2m 5s");
    expect(card.textContent).toContain("×3");
    expect(card.textContent).toContain("opus-5-5");
    expect(screen.getByTitle("claude · claude-opus-5-5")).toBeTruthy();
  });

  it("ticks a running step to now and shows no duration for an unvisited one", () => {
    render(<StepCard node={node({ status: "in_progress", startedAt: "2026-10-04T12:09:20.000Z" })} now={now} flow="task" />);
    expect(screen.getByTestId("step-review").textContent).toContain("40s");
    cleanup();
    render(<StepCard node={node({ status: "queued", visits: 0 })} now={now} flow="task" />);
    expect(screen.getByTestId("step-review").textContent).not.toMatch(/\d/);
  });

  it("shows the kind icon and the eval gate before the name", () => {
    render(<StepCard node={node({ kind: "prompt", evalGate: true })} now={now} flow="task" />);
    expect(screen.getByTestId("kind-prompt").title).toBe("prompt: an agent does the work");
    expect(screen.getByTestId("eval-gate").title).toMatch(/^eval gate/);
    const kind = screen.getByTestId("kind-prompt");
    const gate = screen.getByTestId("eval-gate");
    const name = [...screen.getByTestId("step-review").querySelectorAll("span")].find((s) => s.textContent === "review" && s.getAttribute("role") === null);
    expect(kind.compareDocumentPosition(gate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(gate.compareDocumentPosition(name!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    render(<StepCard node={node({ id: "sync", kind: "module" })} now={now} flow="task" />);
    expect(screen.getByTestId("kind-module")).toBeTruthy();
    expect(screen.queryByTestId("eval-gate")).toBeNull();
    cleanup();
    render(<StepCard node={node({ id: "verify", kind: "eval" })} now={now} flow="task" />);
    expect(screen.getByTestId("kind-eval").title).toBe("eval only: the eval is the work");
    expect(screen.queryByTestId("eval-gate")).toBeNull();
    cleanup();
    render(<StepCard node={node()} now={now} flow="task" />);
    expect(screen.queryByTestId(/^kind-/)).toBeNull();
  });

  it("shows the prepare icon before the agent sparkle, orange while prepare runs, and fades the sparkle when prepare skipped the agent", () => {
    const active = (id: string) => screen.getByTestId(id).className.includes("text-fg-attention");
    render(<StepCard node={node({ id: "sync", kind: "prompt", prepare: true, evalGate: true, status: "in_progress", phase: "prepare" })} now={now} flow="task" />);
    const prepare = screen.getByTestId("prepare");
    expect(prepare.title).toMatch(/^prepare:/);
    expect(prepare.compareDocumentPosition(screen.getByTestId("kind-prompt")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([active("prepare"), active("kind-prompt"), active("eval-gate")]).toEqual([true, false, false]);
    expect(screen.getByTestId("kind-prompt").dataset["skipped"]).toBe("false");
    cleanup();
    render(<StepCard node={node({ id: "sync", kind: "prompt", prepare: true, evalGate: true, agentSkipped: { reason: "merged main cleanly; the checks pass" } })} now={now} flow="task" />);
    const sparkle = screen.getByTestId("kind-prompt");
    expect(sparkle.dataset["skipped"]).toBe("true");
    expect(sparkle.className).toContain("opacity-40");
    expect(sparkle.title).toBe("prompt: an agent does the work; prepare skipped the agent: merged main cleanly; the checks pass");
    expect(active("prepare")).toBe(false);
    cleanup();
    render(<StepCard node={node({ kind: "prompt", evalGate: true })} now={now} flow="task" />);
    expect(screen.queryByTestId("prepare")).toBeNull();
  });

  it("colours the icon of the running phase orange and leaves the others muted", () => {
    const active = (id: string) => screen.getByTestId(id).className.includes("text-fg-attention");
    render(<StepCard node={node({ kind: "prompt", evalGate: true, status: "in_progress", phase: "work" })} now={now} flow="task" />);
    expect([active("kind-prompt"), active("eval-gate")]).toEqual([true, false]);
    cleanup();
    render(<StepCard node={node({ kind: "prompt", evalGate: true, status: "in_progress", phase: "eval" })} now={now} flow="task" />);
    expect([active("kind-prompt"), active("eval-gate")]).toEqual([false, true]);
    cleanup();
    render(<StepCard node={node({ kind: "module", evalGate: true, status: "in_progress", phase: "work" })} now={now} flow="task" />);
    expect([active("kind-module"), active("eval-gate")]).toEqual([true, false]);
    cleanup();
    render(<StepCard node={node({ kind: "eval", status: "in_progress" })} now={now} flow="task" />);
    expect(active("kind-eval")).toBe(false);
    cleanup();
    render(<StepCard node={node({ kind: "eval", status: "in_progress", phase: "eval" })} now={now} flow="task" />);
    expect(active("kind-eval")).toBe(true);
    cleanup();
    render(<StepCard node={node({ kind: "prompt", evalGate: true, status: "success" })} now={now} flow="task" />);
    expect([active("kind-prompt"), active("eval-gate")]).toEqual([false, false]);
    expect(screen.getByTestId("kind-prompt").className).toContain("text-fg-muted");
  });

  it("flags a step the flow file no longer has", () => {
    render(<StepCard node={node({ id: "build", unknown: true })} now={now} flow="task" />);
    expect(screen.getByTitle("not a step of flows/task.yaml any more")).toBeTruthy();
  });

  it("drops the vendor prefix from Claude models only", () => {
    expect(shortModel("claude-opus-5-5")).toBe("opus-5-5");
    expect(shortModel("gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("StepView", () => {
  const detail: StepDetail = {
    id: "review",
    routes: [{ to: "sync", when: "res.ok" }, { to: "fix" }, { to: "blocked", exhausted: true }],
    visits: [
      {
        spanId: "r1-3",
        runId: "r1",
        scope: "84",
        startedAt: "2026-10-04T12:00:00.000Z",
        endedAt: "2026-10-04T12:01:00.000Z",
        next: "sync",
        status: "success",
        iterations: [
          {
            n: 1,
            agent: { kind: "claude", model: "claude-opus-5-5", startedAt: "2026-10-04T12:00:00.000Z", endedAt: "2026-10-04T12:00:40.000Z", outcome: "ok", commits: [], log: "review-1.log", usage: { inputTokens: 1000, outputTokens: 2500, cacheCreationInputTokens: 0, cacheReadInputTokens: 11_000 } },
            eval: { startedAt: "2026-10-04T12:00:40.000Z", endedAt: "2026-10-04T12:01:00.000Z", ok: true },
          },
        ],
      },
    ],
    record: { ok: true, log: "gradle ok\nBUILD SUCCESSFUL", output: { verdict: "clean" }, commits: ["78cd5885aaaa"] },
  };

  it("lists the routes with the one taken marked", () => {
    render(<StepView issue="84" node={node({ endedAt: "2026-10-04T12:01:00.000Z", startedAt: "2026-10-04T12:00:00.000Z" })} detail={detail} now={now} live={false} />);
    const routes = screen.getByTestId("routes").textContent ?? "";
    expect(routes).toContain("res.ok");
    expect(routes).toContain("else");
    expect(routes).toContain("iterations exhausted");
    expect(routes).toContain("taken");
  });

  it("names the step's kind and eval gate in the header", () => {
    render(<StepView issue="84" node={node({ kind: "prompt", evalGate: true })} detail={detail} now={now} live={false} />);
    expect(screen.getByRole("heading", { name: "review" }).parentElement?.textContent).toContain("prompt step with eval gate");
    cleanup();
    render(<StepView issue="84" node={node({ kind: "prompt", prepare: true, evalGate: true })} detail={detail} now={now} live={false} />);
    expect(screen.getByRole("heading", { name: "review" }).parentElement?.textContent).toContain("prompt step with prepare and eval gate");
  });

  it("shows a prepare row before the iterations: whether the agent runs, and the prepared output of the latest visit once opened", () => {
    const visit = detail.visits[0]!;
    const prepared: StepDetail = {
      ...detail,
      visits: [{ ...visit, prepare: { startedAt: visit.startedAt, endedAt: visit.startedAt, agent: "skip", reason: "nothing came in" }, iterations: [] }],
      record: { ...detail.record!, prepared: { agent: "skip", reason: "nothing came in", output: { conflict: false, moved: false } } },
    };
    render(<StepView issue="84" node={node()} detail={prepared} now={now} live={false} />);
    const row = screen.getByTestId("prepare-1");
    expect(row.textContent).toContain("Run prepare · agent skipped: nothing came in");
    fireEvent.click(row.querySelector("button")!);
    expect(row.textContent).toContain('"moved": false');
  });

  it("shows agent and eval rows collapsed, with token usage, and opens the eval log", () => {
    render(<StepView issue="84" node={node()} detail={detail} now={now} live={false} />);
    const agent = screen.getByTestId("agent-1-1");
    expect(agent.textContent).toContain("12k in / 2.5k out tokens");
    expect(agent.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    const evalRow = screen.getByTestId("eval-1-1");
    expect(evalRow.textContent).not.toContain("BUILD SUCCESSFUL");
    fireEvent.click(evalRow.querySelector("button")!);
    expect(evalRow.textContent).toContain("BUILD SUCCESSFUL");
  });

  it("shows output as JSON and commits once opened", () => {
    render(<StepView issue="84" node={node()} detail={detail} now={now} live={false} />);
    fireEvent.click(screen.getByTestId("output").querySelector("button")!);
    expect(screen.getByTestId("output").textContent).toContain('"verdict": "clean"');
    fireEvent.click(screen.getByTestId("commits").querySelector("button")!);
    expect(screen.getByTestId("commits").textContent).toContain("78cd588");
  });

  it("shows the error of a run that crashed during the visit, open", () => {
    const crashed: StepDetail = {
      id: "merge",
      routes: [],
      visits: [{ spanId: "r1-6", runId: "r1", scope: "96", startedAt: "2026-10-04T12:00:00.000Z", status: "failure", error: "merge: refusing to merge: uncommitted changes", iterations: [] }],
    };
    render(<StepView issue="96" node={node({ id: "merge", status: "failure", startedAt: "2026-10-04T12:00:00.000Z" })} detail={crashed} now={now} live={false} />);
    expect(screen.getByTestId("step-view").textContent).toContain("failed: its run crashed before the visit closed");
    expect(screen.getByTestId("crash-1").textContent).toContain("merge: refusing to merge: uncommitted changes");
    expect(screen.getByTestId("job-log").textContent).toContain("the run crashed during this visit");
  });

  it("says a queued step has no visit yet", () => {
    render(<StepView issue="84" node={node({ status: "queued", visits: 0 })} detail={{ id: "review", routes: [], visits: [] }} now={now} live />);
    expect(screen.getByTestId("step-view").textContent).toContain("is queued");
    expect(screen.getByTestId("job-log").textContent).toContain("No visit to review in this run.");
  });
});
