import { describe, expect, it } from "vitest";
import { createGitHubTracker } from "../src/adapters/github.js";
import { isTrackerModule, loadTracker, missingTrackerMethods, trackerModulePath } from "../src/tracker.js";
import { fakeTracker, issue } from "./fakes/index.js";
import { fixture } from "./helpers.js";

const env = (root: string) => ({ root, repoRoot: "/repo", runsDir: `${root}/runs`, labelPrefix: "sous" });

describe("loadTracker", () => {
  it("knows the built-ins by name; local needs its folder", async () => {
    expect(isTrackerModule("github")).toBe(false);
    expect(isTrackerModule("beads")).toBe(false);
    expect(isTrackerModule("local")).toBe(false);
    expect(isTrackerModule("trackers/jira.ts")).toBe(true);
    expect(missingTrackerMethods(createGitHubTracker())).toEqual([]);
    await expect(loadTracker({ tracker: "local", trackerOptions: {} }, env("/p"))).rejects.toThrow("tracker local: trackerOptions.dir must be a non-empty string");
  });

  it("refuses a github repo option that is not owner/name", async () => {
    await expect(loadTracker({ tracker: "github", trackerOptions: { repo: "planning" } }, env("/p"))).rejects.toThrow('trackerOptions.repo must be owner/name, not "planning"');
    await expect(loadTracker({ tracker: "github", trackerOptions: { repo: 3 } }, env("/p"))).rejects.toThrow("trackerOptions.repo must be a non-empty string");
    expect(missingTrackerMethods(await loadTracker({ tracker: "github", trackerOptions: { repo: "sousfactory/planning" } }, env("/p")))).toEqual([]);
  });

  it("builds a project module with its options and the environment", async () => {
    const root = fixture("tracker");
    const tracker = await loadTracker({ tracker: "trackers/custom.ts", trackerOptions: { title: "Custom" } }, env(root));
    expect(await tracker.getIssue("3")).toMatchObject({ id: "3", title: "Custom /repo" });
    expect(trackerModulePath(root, "trackers/custom.ts")).toBe(`${root}/trackers/custom.ts`);
  });

  it("names a missing module and an incomplete one", async () => {
    await expect(loadTracker({ tracker: "trackers/none.ts", trackerOptions: {} }, env(fixture("tracker")))).rejects.toThrow(/trackers\/none\.ts does not exist; name a built-in \(github, beads, local\)/);
    await expect(loadTracker({ tracker: "trackers/half.ts", trackerOptions: {} }, env(fixture("tracker-broken")))).rejects.toThrow(
      "the tracker lacks children, parent, blockers, claim, block, close, setStateLabel, comment, isClosed, list",
    );
    await expect(loadTracker({ tracker: "trackers/no-list.ts", trackerOptions: {} }, env(fixture("tracker-broken")))).rejects.toThrow("the tracker lacks list");
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
