import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatError, validateCommand } from "../../src/commands/validate.js";
import { fixture, io, projectSteps } from "../helpers.js";

/** A tracker block whose building calls nothing, for the repositories that are about something else. */
const TRACKER = "tracker: { type: local, dir: issues, shared: false, labels: sous }\n";

const deps = (root: string) => ({ root, coreStepsDir: projectSteps, engineVersion: "0.9.0" });

/**
 * A repository checkout with a `.sous/` holding `sous.yaml`, the ES module
 * `package.json` and the wrapper `repos:` entries need, then `files` over
 * them (`undefined` removes one); returns the checkout.
 */
const repository = (yaml: string, files: Record<string, string | undefined> = {}): string => {
  const repoRoot = mkdtempSync(join(tmpdir(), "sous-repo-"));
  const all: Record<string, string | undefined> = { "sous.yaml": yaml.includes("tracker:") ? yaml : `${yaml}${TRACKER}`, "package.json": '{ "type": "module" }\n', sous: "#!/bin/sh\n", ...files };
  for (const [path, content] of Object.entries(all)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(repoRoot, ".sous", path)), { recursive: true });
    writeFileSync(join(repoRoot, ".sous", path), content);
  }
  return repoRoot;
};

describe("validateCommand", () => {
  it("exits 0 for the fixture project", async () => {
    const { deps: lines, out, err } = io();
    expect(await validateCommand([], { ...deps(fixture("project")), ...lines })).toBe(0);
    expect(out).toEqual(["ok: sous.yaml and 1 flow(s) valid"]);
    expect(err).toEqual([]);
  });

  it("exits 0 with a note when there are no flows", async () => {
    const root = join(repository("engine: ^0.9.0\n"), ".sous");
    const { deps: lines, out } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(0);
    expect(out).toEqual([`note: no flows under ${join(root, "flows")}; nothing to validate`, "ok: sous.yaml and 0 flow(s) valid"]);
  });

  it("exits 2 and lists every error with file, id and rule", async () => {
    const { deps: lines, out, err } = io();
    expect(await validateCommand([], { ...deps(fixture("invalid")), ...lines })).toBe(2);
    expect(out.filter((l) => !l.startsWith("warning:"))).toEqual([]);
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

  it("exits 2 on a sous.yaml without the tracker block, showing the block to write", async () => {
    const root = join(repository("", { "sous.yaml": "engine: ^0.9.0\n" }), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(2);
    expect(err).toEqual([`sous.yaml: settings: tracker is required: tracker: { type: github, repo: owner/name, shared: false, labels: sous }`, "1 error(s)"]);
  });

  it("exits 2 on each old tracker key, naming the new one, before any schema error", async () => {
    const root = join(repository("engine: ^0.9.0\ntracker: local\ntrackerOptions: { dir: issues }\nlabelPrefix: sous\n"), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(2);
    expect(err[0]).toBe(
      "sous.yaml: settings: tracker is now a block: tracker: { type: github, repo: owner/name, shared: false, labels: sous }; trackerOptions.dir is now tracker.dir; labelPrefix is now tracker.labels",
    );
  });

  it("exits 2 on a missing engine:, naming the key and the line to add", async () => {
    const root = join(repository(TRACKER), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(2);
    expect(err).toEqual([`sous.yaml: settings: ${join(root, "..")} states no engine: range in sous.yaml; add engine: ^0.9.0`, "1 error(s)"]);
  });

  it("builds a tracker module importing sous-factory as a value in a repository without node_modules", async () => {
    const tracker = 'import { SousError } from "sous-factory";\nimport { fakeTracker } from "sous-factory/testing";\nexport default () => ({ ...fakeTracker(), errorName: new SousError("x").name });\n';
    const root = join(repository("engine: ^0.9.0\ntracker: { type: trackers/custom.ts, shared: false, labels: sous }\n", { "trackers/custom.ts": tracker }), ".sous");
    const { deps: lines, out, err } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(0);
    expect(err).toEqual([]);
    expect(out.at(-1)).toBe("ok: sous.yaml and 0 flow(s) valid");
  });

  it("exits 2 on a .sous/ whose package.json is not an ES module package, or is missing, naming the fix", async () => {
    const commonjs = join(repository("engine: ^0.9.0\n", { "package.json": '{ "name": "defs" }\n' }), ".sous");
    const none = join(repository("engine: ^0.9.0\n", { "package.json": undefined }), ".sous");
    const a = io();
    const b = io();
    expect(await validateCommand([], { ...deps(commonjs), ...a.deps })).toBe(2);
    expect(await validateCommand([], { ...deps(none), ...b.deps })).toBe(2);
    expect(a.err[0]).toBe('package.json: package: "type" is not "module", so steps and tracker modules load as CommonJS, where sous-factory cannot be imported; add "type": "module" to .sous/package.json');
    expect(b.err[0]).toBe('package.json: package: there is none, so steps and tracker modules load as CommonJS, where sous-factory cannot be imported; add .sous/package.json with "type": "module"');
  });

  it("exits 2 naming a range that is not a semver range", async () => {
    const root = join(repository("engine: nonsense\n"), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(2);
    expect(err[0]).toBe('sous.yaml: settings: engine: "nonsense" is not a semver range');
  });

  it("exits 2 when this engine does not satisfy the repository's own range", async () => {
    const root = join(repository("engine: ^0.8.0\n"), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(root), ...lines })).toBe(2);
    expect(err[0]).toBe(`sous.yaml: settings: engine 0.9.0 does not satisfy engine: ^0.8.0 of ${join(root, "..")}; run it with an engine in that range or widen the range`);
  });

  it("in a home repository reports every listed repository whose range this engine does not satisfy, by name", async () => {
    const old = repository("engine: ^0.8.0\n");
    const current = repository("engine: ^0.9.0\n");
    const bare = repository(TRACKER);
    const home = join(repository(`engine: ^0.9.0\nrepos: { old: ${old}, current: ${current}, bare: ${bare} }\n`), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(home), ...lines })).toBe(2);
    expect(err).toEqual([
      "sous.yaml: settings: repos.old: engine 0.9.0 does not satisfy engine: ^0.8.0 of old; run it with an engine in that range or widen the range",
      "sous.yaml: settings: repos.bare: bare states no engine: range in sous.yaml; add engine: ^0.9.0",
      "2 error(s)",
    ]);
  });

  it("in a home repository refuses two entries on one tracker with shared: false, naming both", async () => {
    const block = (shared: boolean) => `engine: ^0.9.0\ntracker: { type: github, repo: acme/planning, shared: ${shared}, labels: sous }\n`;
    const api = repository(block(false));
    const web = repository(block(false));
    const docs = repository(block(true));
    const own = repository("engine: ^0.9.0\n");
    const home = join(repository(`engine: ^0.9.0\nrepos: { api: ${api}, web: ${web}, own: ${own} }\n`), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(home), ...lines })).toBe(2);
    expect(err).toEqual(["sous.yaml: settings: repos: api and web use one tracker (github acme/planning) with shared: false; set shared: true in both, or give each its own tracker", "1 error(s)"]);

    const shared = join(repository(`engine: ^0.9.0\nrepos: { docs: ${docs}, more: ${repository(block(true))} }\n`), ".sous");
    const ok = io();
    expect(await validateCommand([], { ...deps(shared), ...ok.deps })).toBe(0);
  });

  it("accepts a home repository without a tracker block whose repos: does not name it, and refuses one that names itself", async () => {
    const api = repository("engine: ^0.9.0\n");
    const home = join(repository("", { "sous.yaml": `engine: ^0.9.0\nrepos: { api: ${api} }\n` }), ".sous");
    const ok = io();
    expect(await validateCommand([], { ...deps(home), ...ok.deps })).toBe(0);
    expect(ok.err).toEqual([]);

    const itself = join(repository("", { "sous.yaml": `engine: ^0.9.0\nrepos: { planning: ., api: ${api} }\n` }), ".sous");
    const bad = io();
    expect(await validateCommand([], { ...deps(itself), ...bad.deps })).toBe(2);
    expect(bad.err).toEqual([`sous.yaml: settings: tracker is required: tracker: { type: github, repo: owner/name, shared: false, labels: sous }`, "1 error(s)"]);
  });

  it("in a home repository refuses a repos: entry that is not a path", async () => {
    const api = repository("engine: ^0.9.0\n");
    const home = join(repository(`engine: ^0.9.0\nrepos: { api: ${api}, web: { path: ../web, tracker: github } }\n`), ".sous");
    const { deps: lines, err } = io();
    expect(await validateCommand([], { ...deps(home), ...lines })).toBe(2);
    expect(err[0]).toBe('sous.yaml: settings: repos.web must be a path, not {"path":"../web","tracker":"github"}');
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
