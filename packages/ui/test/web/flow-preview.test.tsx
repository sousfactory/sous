// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowView } from "../../server/model";
import { FlowPreview } from "../../src/components/FlowPreview";

const view: FlowView = {
  name: "task",
  entry: "init",
  nodes: [
    { id: "init", status: "queued", visits: 0, uses: "init", kind: "module" },
    { id: "review", status: "queued", visits: 0, uses: "review", kind: "prompt", evalGate: true, agent: { kind: "claude", model: "claude-opus-5-5" } },
  ],
  edges: [{ from: "init", to: "review", taken: false }],
  details: {
    init: { id: "init", uses: "init", routes: [{ to: "review" }] },
    review: { id: "review", uses: "review", description: "Judge the diff cold and read-only.", routes: [{ to: "done", when: "res.ok" }, { to: "fix" }] },
  },
};

beforeEach(() => {
  // React Flow measures its canvas; jsdom has no ResizeObserver.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => view })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlowPreview", () => {
  it("draws the flow with its step count and entry, and no step open", async () => {
    render(<FlowPreview flow="task" step={undefined} onStep={() => {}} now={0} />);
    const preview = await screen.findByTestId("flow-preview");
    expect(preview.textContent).toContain("task.yaml");
    expect(preview.textContent).toContain("2 steps · starts at init");
    expect(screen.queryByTestId("flow-step")).toBeNull();
  });

  it("shows the open step's uses, kind, model, description and routes, and closes it", async () => {
    const onStep = vi.fn();
    render(<FlowPreview flow="task" step="review" onStep={onStep} now={0} />);
    const step = await screen.findByTestId("flow-step");
    expect(step.textContent).toContain("uses review · prompt step with eval gate · claude opus-5-5");
    expect(step.textContent).toContain("Judge the diff cold and read-only.");
    expect(screen.getByTestId("routes").textContent).toContain("res.ok");
    fireEvent.click(screen.getByRole("button", { name: "Close step" }));
    expect(onStep).toHaveBeenCalledWith(undefined);
  });
});
