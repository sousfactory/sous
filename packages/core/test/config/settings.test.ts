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
      labelPrefix: "sous",
      lifecycle: "core",
      idleTimeoutSeconds: 1800,
      tracker: "github",
      trackerOptions: {},
    });
  });

  it("takes any tracker name, since a path names a project module, and options for it", () => {
    expect(parseSettings({ tracker: "beads" })).toEqual({ ...DEFAULT_SETTINGS, tracker: "beads" });
    expect(parseSettings({ tracker: "trackers/jira.ts", trackerOptions: { project: "CA" } })).toEqual({ ...DEFAULT_SETTINGS, tracker: "trackers/jira.ts", trackerOptions: { project: "CA" } });
    expect(() => parseSettings({ tracker: "" })).toThrow(/tracker/);
    expect(() => parseSettings({ trackerOptions: "x" })).toThrow(/trackerOptions must be object/);
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
    expect(() => parseSettings({ labelPrefix: null })).toThrow(/labelPrefix must be string/);
    expect(() => parseSettings({ lifecycle: "mirror" })).toThrow(/lifecycle/);
  });

  it.each([
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
    expect(loadSettings(fixture("project", "sous.yaml"))).toEqual({ ...DEFAULT_SETTINGS, baseBranch: "develop", lifecycle: "steps", idleTimeoutSeconds: 60 });
  });

  it("names the file in a violation", () => {
    expect(() => loadSettings(fixture("bad-settings", "sous.yaml"))).toThrow(/bad-settings\/sous\.yaml: .*unknownKey.*idleTimeoutSeconds must be integer/);
  });
});
