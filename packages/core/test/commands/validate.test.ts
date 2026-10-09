import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatError, validateCommand } from "../../src/commands/validate.js";
import { fixture, io, projectSteps } from "../helpers.js";

const deps = (root: string) => ({ root, coreStepsDir: projectSteps });

describe("validateCommand", () => {
  it("exits 0 for the fixture project", async () => {
    const { deps: lines, out, err } = io();
    expect(await validateCommand([], { ...deps(fixture("project")), ...lines })).toBe(0);
    expect(out).toEqual(["ok: sous.yaml and 1 flow(s) valid"]);
    expect(err).toEqual([]);
  });

  it("exits 0 with a note when there are no flows", async () => {
    const root = mkdtempSync(join(tmpdir(), "sous-"));
    const { deps: lines, out } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(0);
    expect(out).toEqual([`note: no flows under ${join(root, "flows")}; nothing to validate`, "ok: sous.yaml and 0 flow(s) valid"]);
  });

  it("exits 2 and lists every error with file, id and rule", async () => {
    const { deps: lines, out, err } = io();
    expect(await validateCommand([], { ...deps(fixture("invalid")), ...lines })).toBe(2);
    expect(out).toEqual([]);
    expect(err).toContain('flows/gate.yaml [merge]: gate: gate is not supported yet');
    expect(err).toContain('flows/entry-unknown.yaml: entry: entry "nope" names no step id');
    expect(err.at(-1)).toMatch(/^\d+ error\(s\)$/);
  });

  it("exits 2 for a broken sous.yaml", async () => {
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(fixture("bad-settings")), ...lines })).toBe(2);
    expect(err[0]).toMatch(/^sous\.yaml: settings: /);
  });

  it("builds a project tracker module and reports one that is not a tracker", async () => {
    const good = io();
    expect(await validateCommand([], { ...deps(fixture("tracker")), ...good.deps })).toBe(0);
    const bad = io();
    expect(await validateCommand([], { ...deps(fixture("tracker-broken")), ...bad.deps })).toBe(2);
    expect(bad.err[0]).toMatch(/^sous\.yaml: settings: tracker: .*half\.ts: the tracker lacks children, parent, blockers/);
  });

  it("exits 2 with usage on arguments", async () => {
    const { deps: lines, err } = io();
    expect(await validateCommand(["x"], { ...deps(fixture("project")), ...lines })).toBe(2);
    expect(err).toEqual(["usage: sous validate"]);
  });
});

describe("formatError", () => {
  it("renders the file relative to the root, the id in brackets and the rule", () => {
    expect(formatError("/r", { file: "/r/flows/a.yaml", id: "x", rule: "with", message: "m" })).toBe("flows/a.yaml [x]: with: m");
    expect(formatError("/r", { file: "/r/sous.yaml", rule: "settings", message: "m" })).toBe("sous.yaml: settings: m");
  });
});
