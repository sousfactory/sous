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
    await writeFile(join(root, "sous.yaml"), "tracker: { type: local, dir: issues, shared: false, labels: sous }\n");
    expect(await startRun(["7", "--flow", "walk"], deps())).toBe(2);
    expect(await startWatch(["--once"], deps())).toBe(2);
    expect(err).toEqual([`sous run: ${repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.1`, `sous watch: ${repoRoot} states no engine: range in sous.yaml; add engine: ^0.9.1`]);
    expect(existsSync(locksDir(root))).toBe(false);
  });

  it("sous run and sous watch refuse each old tracker key, naming the new one, before any lock", async () => {
    await writeFile(join(root, "sous.yaml"), "engine: ^0.9.0\ntracker: github\ntrackerOptions: { repo: acme/web }\nlabelPrefix: sous\n");
    const refusal = `${join(root, "sous.yaml")}: tracker is now a block: tracker: { type: github, repo: owner/name, shared: false, labels: sous }; trackerOptions.repo is now tracker.repo; labelPrefix is now tracker.labels`;
    await expect(startRun(["7", "--flow", "walk"], deps())).rejects.toThrow(refusal);
    await expect(startWatch(["--once"], deps())).rejects.toThrow(refusal);
    expect(existsSync(locksDir(root))).toBe(false);
  });

  it("sous run and sous watch refuse a repository without the tracker block, showing the block to write", async () => {
    await writeFile(join(root, "sous.yaml"), "engine: ^0.9.0\n");
    const refusal = `${join(root, "sous.yaml")}: tracker is required: tracker: { type: github, repo: owner/name, shared: false, labels: sous }`;
    await expect(startRun(["7", "--flow", "walk"], deps())).rejects.toThrow(refusal);
    await expect(startWatch(["--once"], deps())).rejects.toThrow(refusal);
  });

  it("sous run and sous watch refuse an engine: that is no semver range with exit 2 and their prefix, naming the value", async () => {
    await writeFile(join(root, "sous.yaml"), "engine: nonsense\n");
    expect(await startRun(["7", "--flow", "walk"], deps())).toBe(2);
    expect(await startWatch(["--once"], deps())).toBe(2);
    expect(err).toEqual(['sous run: engine: "nonsense" is not a semver range', 'sous watch: engine: "nonsense" is not a semver range']);
    expect(existsSync(locksDir(root))).toBe(false);
  });

  describe("in a home repository", () => {
    /** Entry `name` beside the home one, on its own local tracker, holding `issues` as files. */
    const entry = async (name: string, issues: { id: string; labels: string[]; state?: string }[]): Promise<string> => {
      const entryRoot = join(repoRoot, name, ".sous");
      await mkdir(join(entryRoot, "issues"), { recursive: true });
      await writeFile(join(entryRoot, "sous.yaml"), "engine: ^0.9.0\ntracker: { type: local, dir: issues, shared: false, labels: sous }\n");
      for (const i of issues) await writeFile(join(entryRoot, "issues", `${i.id}.json`), JSON.stringify({ title: `Issue ${i.id}`, body: "", ...i }));
      return join(entryRoot, "issues");
    };

    beforeEach(async () => {
      // A home with no tracker of its own: the entries' trackers are asked.
      await writeFile(join(root, "sous.yaml"), "engine: ^0.9.0\nrepos: { a: a, b: b }\n");
    });

    it("sous run asks every entry's tracker: a number two of them hold is refused with the qualified forms, one none holds names the trackers asked", async () => {
      const a = await entry("a", [{ id: "42", labels: ["type:task"] }]);
      const b = await entry("b", [{ id: "42", labels: ["type:task"] }]);
      expect(await startRun(["42"], deps())).toBe(2);
      expect(await startRun(["7"], deps())).toBe(2);
      expect(err).toEqual(["sous run: issue 42 is in several trackers; name the entry: sous run a#42, sous run b#42", `sous run: issue 7 is in none of the trackers asked (local ${a}, local ${b})`]);
      expect(existsSync(locksDir(root))).toBe(false);
    });

    it("sous run --repo exits 2 naming the qualified form", async () => {
      await entry("a", []);
      await entry("b", []);
      expect(await startRun(["42", "--repo", "b"], deps())).toBe(2);
      expect(err).toEqual(["sous run: --repo is gone; name the entry with the issue: sous run b#42\nusage: sous run <issue | name#issue> [--flow <name>] [--restart]"]);
    });
  });
});
