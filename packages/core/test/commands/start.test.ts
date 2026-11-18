import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locksDir } from "../../src/commands/lock.js";
import { startRun, startWatch } from "../../src/commands/start.js";

/** The CLI's `sous run` and `sous watch` as typed: settings and the tracker load after the engine range is checked. */
describe("sous run and sous watch from the command line", () => {
  let repoRoot: string;
  let root: string;
  let out: string[];
  let err: string[];

  const deps = () => ({ root, cliFile: "/engine/cli.js", engineVersion: "0.9.1", out: (l: string) => out.push(l), err: (l: string) => err.push(l) });

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sous-start-"));
    root = join(repoRoot, ".sous");
    await mkdir(root);
    // Written for a newer engine: a key this engine's strict settings schema rejects.
    await writeFile(join(root, "sous.yaml"), "engine: ^0.10.0\nfromTheFuture: true\n");
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("sous run refuses a repository written for a newer engine by its range, not by the settings key it does not know", async () => {
    expect(await startRun(["7", "--flow", "walk"], deps())).toBe(2);
    expect(err).toEqual([`sous run: engine 0.9.1 does not satisfy engine: ^0.10.0 of ${repoRoot}; run it with an engine in that range or widen the range`]);
  });

  it("sous watch refuses to start on a repository written for a newer engine by its range, not by the settings key, with the remedy sous run names", async () => {
    expect(await startWatch(["--once"], deps())).toBe(2);
    expect(err).toEqual([`sous watch: engine 0.9.1 does not satisfy engine: ^0.10.0 of ${repoRoot}; run it with an engine in that range or widen the range`]);
  });

  it("sous run and sous watch refuse a repository without engine:, naming the key and the line to add, before any lock", async () => {
    await writeFile(join(root, "sous.yaml"), "tracker: local\n");
    expect(await startRun(["7", "--flow", "walk"], deps())).toBe(2);
    expect(await startWatch(["--once"], deps())).toBe(2);
    expect(err).toEqual([`sous run: ${repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.1`, `sous watch: ${repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.1`]);
    expect(existsSync(locksDir(root))).toBe(false);
  });

  it("sous run and sous watch refuse an engine: that is no semver range with exit 2 and their prefix, naming the value", async () => {
    await writeFile(join(root, "sous.yaml"), "engine: nonsense\n");
    expect(await startRun(["7", "--flow", "walk"], deps())).toBe(2);
    expect(await startWatch(["--once"], deps())).toBe(2);
    expect(err).toEqual(['sous run: engine: "nonsense" is not a semver range', 'sous watch: engine: "nonsense" is not a semver range']);
    expect(existsSync(locksDir(root))).toBe(false);
  });
});
