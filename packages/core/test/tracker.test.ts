import { describe, expect, it } from "vitest";
import { isTrackerModule, loadTracker, missingTrackerMethods, trackerModulePath } from "../src/tracker.js";
import { fakeTracker, issue } from "./fakes/index.js";
import { fixture } from "./helpers.js";

const env = (root: string) => ({ root, repoRoot: "/repo", runsDir: `${root}/runs` });
const block = (type: string, more: Record<string, unknown> = {}) => ({ tracker: { type, shared: false, labels: "sous", ...more } });

describe("loadTracker", () => {
  it("knows the built-ins by name", () => {
    expect(isTrackerModule("github")).toBe(false);
    expect(isTrackerModule("beads")).toBe(false);
    expect(isTrackerModule("local")).toBe(false);
    expect(isTrackerModule("trackers/jira.ts")).toBe(true);
  });

  it("refuses a sous.yaml without the tracker block, showing the block to write", async () => {
    await expect(loadTracker({}, env("/p"))).rejects.toThrow("/p/sous.yaml: tracker is required: tracker: { type: github, repo: owner/name, shared: false, labels: sous }");
  });

  it("requires the location of github and local, and none of beads", async () => {
    await expect(loadTracker(block("github"), env("/p"))).rejects.toThrow("/p/sous.yaml: tracker.repo is required for github");
    await expect(loadTracker(block("local"), env("/p"))).rejects.toThrow("/p/sous.yaml: tracker.dir is required for local");
    expect(missingTrackerMethods(await loadTracker(block("github", { repo: "sousfactory/planning" }), env("/p")))).toEqual([]);
    expect(missingTrackerMethods(await loadTracker(block("local", { dir: "issues" }), env("/p")))).toEqual([]);
    expect(missingTrackerMethods(await loadTracker(block("beads"), env("/p")))).toEqual([]);
  });

  it("builds a project module with the block and the environment, labels as labelPrefix", async () => {
    const root = fixture("tracker");
    const tracker = await loadTracker(block("trackers/custom.ts", { title: "Custom" }), env(root));
    expect(await tracker.getIssue("3")).toMatchObject({ id: "3", title: "Custom /repo sous" });
    expect(trackerModulePath(root, "trackers/custom.ts")).toBe(`${root}/trackers/custom.ts`);
  });

  it("names a missing module and an incomplete one", async () => {
    await expect(loadTracker(block("trackers/none.ts"), env(fixture("tracker")))).rejects.toThrow(/trackers\/none\.ts does not exist; name a built-in \(github, beads, local\)/);
    await expect(loadTracker(block("trackers/half.ts"), env(fixture("tracker-broken")))).rejects.toThrow(
      "the tracker lacks children, parent, blockers, claim, block, close, setStateLabel, comment, isClosed, list",
    );
    await expect(loadTracker(block("trackers/no-list.ts"), env(fixture("tracker-broken")))).rejects.toThrow("the tracker lacks list");
  });
});

describe("fakeTracker list", () => {
  it("answers from its seeded issues: open and carrying every label, in ascending numeric id order", async () => {
    const tracker = fakeTracker({
      issues: [
        issue({ id: "10", labels: ["sous:ready", "type:task"] }),
        issue({ id: "4", labels: ["sous:ready", "type:task"] }),
        issue({ id: "2", labels: ["sous:ready", "type:task", "repo:web"] }),
        issue({ id: "3", labels: ["sous:ready"] }),
        issue({ id: "5", labels: ["sous:ready", "type:task"], state: "closed" }),
      ],
    });
    const listed = await tracker.list({ labels: ["sous:ready", "type:task"] });
    expect(listed.map((i) => i.id)).toEqual(["2", "4", "10"]);
    expect(listed[0]).toMatchObject({ labels: ["sous:ready", "type:task", "repo:web"], state: "open" });
  });
});
