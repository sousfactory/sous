import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, projectDirs } from "../../src/config/settings.js";
import { fixture } from "../helpers.js";

describe("parseSettings", () => {
  it("yields every default for an empty document", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("has the documented defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      baseBranch: "main",
      branch: "feature/${{ issue.id }}-${{ slug }}",
      specsDir: "../specs",
      flowsDir: "flows",
      stepsDir: "steps",
      skillsDir: "skills",
      templatesDir: "templates",
      logsDir: "logs",
      runsDir: "runs",
      lifecycle: "core",
      idleTimeoutSeconds: 1800,
      uiPort: 4680,
    });
  });

  it("takes the tracker block: type, location, shared and labels", () => {
    const tracker = { type: "github", repo: "acme/web", shared: false, labels: "sous" };
    expect(parseSettings({ tracker })).toEqual({ ...DEFAULT_SETTINGS, tracker });
    expect(parseSettings({ tracker: { type: "local", dir: "issues", shared: true, labels: "factory" } }).tracker).toEqual({ type: "local", dir: "issues", shared: true, labels: "factory" });
    expect(parseSettings({ tracker: { type: "beads", shared: false, labels: "sous" } }).tracker).toEqual({ type: "beads", shared: false, labels: "sous" });
  });

  it("hands a module type whatever further keys it documents, under the same block", () => {
    const tracker = { type: "trackers/jira.ts", shared: true, labels: "sous", project: "CA", board: { id: 3 } };
    expect(parseSettings({ tracker }).tracker).toEqual(tracker);
  });

  it.each([
    [{ repo: "acme/web", shared: false, labels: "sous" }, "sous.yaml: tracker.type is required: github, beads, local, or the path of a tracker module"],
    [{ type: "github", repo: "acme/web", labels: "sous" }, "sous.yaml: tracker.shared is required: true when the tracker holds the issues of several repositories, false when it holds this one's alone"],
    [{ type: "github", repo: "acme/web", shared: false }, "sous.yaml: tracker.labels is required: the prefix of the sous:* labels, sous unless you chose another"],
    [{ type: "github", shared: false, labels: "sous" }, "sous.yaml: tracker.repo is required for github: the owner/name of the repository the issues live in"],
    [{ type: "github", repo: "owner/name", shared: false, labels: "sous" }, "sous.yaml: tracker.repo is required for github: the owner/name of the repository the issues live in, not the owner/name placeholder"],
    [{ type: "local", shared: false, labels: "sous" }, "sous.yaml: tracker.dir is required for local: the folder of the issue files, relative to .sous/"],
  ])("refuses the block %j naming the missing key", (tracker, message) => {
    expect(() => parseSettings({ tracker }, "sous.yaml")).toThrow(message);
  });

  it.each([
    [{ type: "github", repo: "planning", shared: false, labels: "sous" }, 'sous.yaml: tracker.repo must be owner/name, not "planning"'],
    [{ type: "github", repo: "acme/web", shared: "no", labels: "sous" }, "sous.yaml: tracker.shared must be true or false"],
    [{ type: "github", repo: "acme/web", shared: false, labels: "" }, "sous.yaml: tracker.labels must be a non-empty string"],
    [{ type: "local", dir: 3, shared: false, labels: "sous" }, "sous.yaml: tracker.dir must be a non-empty string"],
  ])("refuses the block %j naming the wrong key", (tracker, message) => {
    expect(() => parseSettings({ tracker }, "sous.yaml")).toThrow(message);
  });

  it("refuses each old key with the new key to type, before any schema error", () => {
    expect(() => parseSettings({ tracker: "github" }, "sous.yaml")).toThrow("sous.yaml: tracker is now a block: tracker: { type: github, repo: owner/name, shared: false, labels: sous }");
    expect(() => parseSettings({ labelPrefix: "sous" }, "sous.yaml")).toThrow("sous.yaml: labelPrefix is now tracker.labels");
    expect(() => parseSettings({ trackerOptions: { repo: "acme/web" } }, "sous.yaml")).toThrow("sous.yaml: trackerOptions.repo is now tracker.repo");
    expect(() => parseSettings({ tracker: "local", trackerOptions: { dir: "issues" }, labelPrefix: "x", unknownKey: 1 }, "sous.yaml")).toThrow(
      "sous.yaml: tracker is now a block: tracker: { type: local, dir: issues, shared: false, labels: sous }; trackerOptions.dir is now tracker.dir; labelPrefix is now tracker.labels",
    );
    expect(() => parseSettings({ trackerOptions: {} }, "sous.yaml")).toThrow("sous.yaml: trackerOptions is now the tracker block: tracker.<key>");
  });

  it("refuses a string tracker with a block of its own type", () => {
    expect(() => parseSettings({ tracker: "beads" }, "sous.yaml")).toThrow("sous.yaml: tracker is now a block: tracker: { type: beads, shared: false, labels: sous }");
    expect(() => parseSettings({ tracker: "local" }, "sous.yaml")).toThrow("sous.yaml: tracker is now a block: tracker: { type: local, dir: issues, shared: false, labels: sous }");
    expect(() => parseSettings({ tracker: "trackers/jira.ts" }, "sous.yaml")).toThrow("sous.yaml: tracker is now a block: tracker: { type: trackers/jira.ts, shared: false, labels: sous }");
  });

  it("resolves every dir against the project root", () => {
    expect(projectDirs("/repo/.sous", { ...DEFAULT_SETTINGS, runsDir: "/elsewhere/runs" })).toEqual({
      specs: "/repo/specs",
      flows: "/repo/.sous/flows",
      steps: "/repo/.sous/steps",
      skills: "/repo/.sous/skills",
      templates: "/repo/.sous/templates",
      logs: "/repo/.sous/logs",
      runs: "/elsewhere/runs",
    });
  });

  it("overrides only the keys given; the lifecycle is core or steps", () => {
    expect(parseSettings({ lifecycle: "steps", specsDir: "docs/specs" })).toEqual({
      ...DEFAULT_SETTINGS,
      lifecycle: "steps",
      specsDir: "docs/specs",
    });
    expect(() => parseSettings({ lifecycle: "mirror" })).toThrow(/lifecycle/);
  });

  it("takes a uiPort, so each project picks the port sous ui listens on", () => {
    expect(parseSettings({ uiPort: 5001 })).toEqual({ ...DEFAULT_SETTINGS, uiPort: 5001 });
  });

  it("takes engine: as a semver range and rejects one that is not, naming the value", () => {
    expect(parseSettings({ engine: "^0.9.0" })).toEqual({ ...DEFAULT_SETTINGS, engine: "^0.9.0" });
    expect(() => parseSettings({ engine: "nonsense" }, "sous.yaml")).toThrow('sous.yaml: engine: "nonsense" is not a semver range');
  });

  it.each([
    [{ uiPort: "4680a" }, "/uiPort must be integer"],
    [{ uiPort: 46.8 }, "/uiPort must be integer"],
    [{ uiPort: 0 }, "/uiPort must be >= 1"],
    [{ uiPort: 65536 }, "/uiPort must be <= 65535"],
    [{ idleTimeoutSeconds: "soon" }, "/idleTimeoutSeconds must be integer"],
    [{ idleTimeoutSeconds: 0 }, "/idleTimeoutSeconds must be >= 1"],
    [{ unknownKey: 1 }, "must NOT have additional properties (unknownKey)"],
    [{ baseBranch: 3 }, "/baseBranch must be string"],
    [[], "/ must be object"],
  ])("rejects %j", (doc, message) => {
    expect(() => parseSettings(doc, "sous.yaml")).toThrow(message);
    expect(() => parseSettings(doc, "sous.yaml")).toThrow(/^sous\.yaml: /);
  });
});

describe("loadSettings", () => {
  it("returns the defaults for a missing file", () => {
    expect(loadSettings(join(mkdtempSync(join(tmpdir(), "sous-")), "sous.yaml"))).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for an empty file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "sous-")), "sous.yaml");
    writeFileSync(file, "# nothing here\n");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("merges a project file over the defaults", () => {
    expect(loadSettings(fixture("project", "sous.yaml"))).toEqual({
      ...DEFAULT_SETTINGS,
      baseBranch: "develop",
      lifecycle: "steps",
      idleTimeoutSeconds: 60,
      engine: ">=0.1.0",
      tracker: { type: "github", repo: "acme/web", shared: false, labels: "sous" },
    });
  });

  it("names the file in a violation", () => {
    expect(() => loadSettings(fixture("bad-settings", "sous.yaml"))).toThrow(/bad-settings\/sous\.yaml: .*unknownKey.*idleTimeoutSeconds must be integer/);
  });
});
