import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/exec.js";
import { ownerNameOf, repoEntries, repoNameOf, routeIssue, sameLocationProblems, trackerLocationOf } from "../../src/config/repos.js";
import { DEFAULT_SETTINGS, parseSettings } from "../../src/config/settings.js";
import { validateProject } from "../../src/config/validate.js";

/** A home repository at `<tmp>/home` whose `.sous/sous.yaml` is `yaml`, with sibling checkouts `a` and `b` holding a project, `bare` one without its `.sous/sous`. */
const workspace = (yaml: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sous-repos-"));
  for (const repo of ["a", "b", "bare"]) {
    mkdirSync(join(dir, repo, ".sous"), { recursive: true });
    writeFileSync(join(dir, repo, ".sous", "sous.yaml"), "");
    if (repo !== "bare") writeFileSync(join(dir, repo, ".sous", "sous"), "#!/bin/sh\n");
  }
  mkdirSync(join(dir, "c"));
  const root = join(dir, "home", ".sous");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "sous.yaml"), yaml);
  return { dir, root };
};

describe("repos in sous.yaml", () => {
  it("maps names to checkout paths relative to the repository root, absolute and ~ allowed", () => {
    const settings = parseSettings({ repos: { a: "../a", b: "/srv/b", c: "~/c", self: "." } });
    expect(repoEntries("/w/home/.sous", settings)).toEqual([
      { name: "a", path: "/w/a" },
      { name: "b", path: "/srv/b" },
      { name: "c", path: join(homedir(), "c") },
      { name: "self", path: "/w/home" },
    ]);
  });

  it("names each path of a plain list by its folder", () => {
    expect(repoEntries("/w/home/.sous", parseSettings({ repos: ["../api", "../web/", "."] }))).toEqual([
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
      { name: "home", path: "/w/home" },
    ]);
  });

  it("is absent without repos", () => {
    expect(repoEntries("/w/home/.sous", DEFAULT_SETTINGS)).toBeUndefined();
  });

  it("refuses an entry that is not a string, naming it", () => {
    expect(() => parseSettings({ repos: { a: "../a", b: 3 } }, "sous.yaml")).toThrow("sous.yaml: repos.b must be a path, not 3");
    expect(() => parseSettings({ repos: ["../a", { b: "../b" }] }, "sous.yaml")).toThrow('sous.yaml: repos[1] must be a path, not {"b":"../b"}');
    expect(() => parseSettings({ repos: "../a" }, "sous.yaml")).toThrow("sous.yaml: repos must be a map of name to path or a list of paths");
  });
});

describe("sous validate with repos", () => {
  it("passes when every listed path holds a .sous/sous.yaml", () => {
    expect(validateProject(workspace("repos: { a: ../a, b: ../b }\n").root).errors).toEqual([]);
  });

  it("reports a listed path without a .sous/sous.yaml, with the path", () => {
    const { dir, root } = workspace("repos: { a: ../a, c: ../c, gone: ../gone }\n");
    expect(validateProject(root).errors.map((e) => [e.rule, e.message])).toEqual([
      ["settings", `repos.c: ${join(dir, "c")} holds no .sous/sous.yaml`],
      ["settings", `repos.gone: ${join(dir, "gone")} holds no .sous/sous.yaml`],
    ]);
  });

  it("passes a listed project without a .sous/sous wrapper or node_modules: the running engine runs it", () => {
    expect(validateProject(workspace("repos: { a: ../a, bare: ../bare }\n").root).errors).toEqual([]);
  });

  it("reports a repos entry that is not a string", () => {
    const { root } = workspace("repos: { a: ../a, b: [../b] }\n");
    expect(validateProject(root).errors.map((e) => [e.rule, e.message])).toEqual([["settings", 'repos.b must be a path, not ["../b"]']]);
  });

  it("reports two list entries named by the same folder", () => {
    const { root } = workspace("repos: [../a, ../x/a]\n");
    expect(validateProject(root).errors.map((e) => e.message)).toContain("repos: two entries are named a; use a map to name them apart");
  });
});

describe("ownerNameOf", () => {
  it("reads owner/name from a github.com origin in every form git writes", () => {
    for (const url of [
      "git@github.com:acme/web.git",
      "git@github.com:acme/web",
      "https://github.com/acme/web",
      "https://github.com/acme/web.git/",
      "http://github.com/acme/web/",
      "ssh://git@github.com/acme/web.git",
      "git://github.com/acme/web.git",
    ])
      expect(ownerNameOf(url)).toBe("acme/web");
  });

  it("reads nothing from another host or a path of more than owner/name", () => {
    for (const url of [
      "git@gitlab.com:acme/web.git",
      "https://gitlab.com/group/sub/web.git",
      "https://github.example.com/acme/web",
      "https://github.com/acme/web/extra",
      "git@github.com:acme/team/web.git",
      "https://github.com/acme",
      "/srv/git/acme/web.git",
      "",
    ])
      expect(ownerNameOf(url)).toBeUndefined();
  });
});

describe("repoNameOf", () => {
  const origin =
    (url: string | undefined): Exec =>
    async (command, args) => {
      expect([command, ...args]).toEqual(["git", "remote", "get-url", "origin"]);
      return url === undefined ? { code: 2, stdout: "", stderr: "error: No such remote 'origin'" } : { code: 0, stdout: `${url}\n`, stderr: "" };
    };

  it("is name: in sous.yaml first", async () => {
    expect(await repoNameOf("/w/checkout", { ...DEFAULT_SETTINGS, name: "api" }, origin("git@github.com:acme/web.git"))).toBe("api");
  });

  it("is the repository part of the origin remote next, ssh or https", async () => {
    expect(await repoNameOf("/w/checkout", DEFAULT_SETTINGS, origin("git@github.com:acme/web.git"))).toBe("web");
    expect(await repoNameOf("/w/checkout", DEFAULT_SETTINGS, origin("https://github.com/acme/web-app"))).toBe("web-app");
  });

  it("is the folder name without an origin remote", async () => {
    expect(await repoNameOf("/w/checkout", DEFAULT_SETTINGS, origin(undefined))).toBe("checkout");
  });
});

describe("routeIssue for an issue a tracker listed", () => {
  const unshared = (name: string) => ({ name, shared: false, location: { type: "github", at: `acme/${name}` } });
  const planning = { type: "github", at: "acme/planning" };
  const onPlanning = (name: string) => ({ name, shared: true, location: planning });

  describe("on an unshared tracker", () => {
    const scope = { listedBy: unshared("api"), entries: [unshared("api"), onPlanning("web")], home: true };

    it("runs in the entry that listed it, without a label or with one naming that entry", () => {
      expect(routeIssue(["type:task"], scope)).toEqual({ to: "api" });
      expect(routeIssue(["repo:api"], scope)).toEqual({ to: "api" });
    });

    it("skips one naming another repository, entry or not", () => {
      expect(routeIssue(["repo:web"], scope)).toEqual({ reason: "repo:web names another repository than api" });
      expect(routeIssue(["repo:zzz"], scope)).toEqual({ reason: "repo:zzz names another repository than api" });
    });
  });

  describe("on a shared tracker", () => {
    const scope = { listedBy: onPlanning("web"), entries: [unshared("api"), onPlanning("web"), onPlanning("docs"), { name: "gone" }], home: true };

    it("runs in the entry its label names among those on the tracker", () => {
      expect(routeIssue(["repo:docs"], scope)).toEqual({ to: "docs" });
      expect(routeIssue(["repo:web"], scope)).toEqual({ to: "web" });
    });

    it("skips an unlabelled issue, naming the tracker and the labels that would place it", () => {
      expect(routeIssue(["type:task"], scope)).toEqual({ reason: "tracker acme/planning is shared; add repo:web or repo:docs" });
      expect(routeIssue([], { listedBy: onPlanning("app"), entries: [onPlanning("app")], home: false })).toEqual({ reason: "tracker acme/planning is shared; add repo:app" });
    });

    it("skips several labels and an unknown name with the existing reasons", () => {
      expect(routeIssue(["repo:web", "repo:docs"], scope)).toEqual({ reason: "carries several repo:* labels (repo:web, repo:docs); keep one" });
      expect(routeIssue(["repo:zzz"], scope)).toEqual({ reason: "repo:zzz names no entry of repos: (api, web, docs, gone)" });
      expect(routeIssue(["repo:web"], { listedBy: onPlanning("app"), entries: [onPlanning("app")], home: false })).toEqual({ reason: "repo:web names another repository than app" });
    });

    it("skips one naming an entry whose own tracker is elsewhere: a run there could not find it", () => {
      expect(routeIssue(["repo:api"], scope)).toEqual({ reason: "repo:api, but the tracker of api does not list it; a run in api could not find it" });
    });

    it("leaves one naming an entry sous watch cannot run to that entry", () => {
      expect(routeIssue(["repo:gone"], scope)).toEqual({ to: "gone" });
    });
  });
});

describe("trackerLocationOf", () => {
  const place = { root: "/w/app/.sous", repoRoot: "/w/app" };

  it("is the github repository, the local folder, the beads checkout", () => {
    expect(trackerLocationOf({ type: "github", repo: "acme/app", shared: false, labels: "sous" }, place)).toEqual({ type: "github", at: "acme/app" });
    expect(trackerLocationOf({ type: "local", dir: "../issues", shared: false, labels: "sous" }, place)).toEqual({ type: "local", at: "/w/app/issues" });
    expect(trackerLocationOf({ type: "beads", shared: false, labels: "sous" }, place)).toEqual({ type: "beads", at: "/w/app" });
  });

  it("is a module's path and its own keys, so one module with the same options is one tracker", () => {
    expect(trackerLocationOf({ type: "./jira.ts", project: "ACME", shared: true, labels: "sous" }, place)).toEqual({ type: "/w/app/.sous/jira.ts", at: '{"project":"ACME"}' });
    expect(trackerLocationOf({ type: "../../app/.sous/jira.ts", labels: "x", project: "ACME", shared: true }, { root: "/w/x/y", repoRoot: "/w/x" })).toEqual({ type: "/w/app/.sous/jira.ts", at: '{"project":"ACME"}' });
  });
});

describe("sameLocationProblems", () => {
  const at = (name: string, shared: boolean, where = "acme/planning") => ({ name, shared, location: { type: "github", at: where } });

  it("accepts entries on distinct trackers, and shared entries on one", () => {
    expect(sameLocationProblems([at("api", false, "acme/api"), at("web", true), at("docs", true)])).toEqual([]);
  });

  it("names the two entries on one tracker where either is not shared", () => {
    expect(sameLocationProblems([at("api", false), at("web", false)])).toEqual(["repos: api and web use one tracker (github acme/planning) with shared: false; set shared: true in both, or give each its own tracker"]);
    expect(sameLocationProblems([at("api", true), at("web", false)])).toEqual(["repos: api and web use one tracker (github acme/planning) with shared: false; set shared: true in both, or give each its own tracker"]);
  });
});
