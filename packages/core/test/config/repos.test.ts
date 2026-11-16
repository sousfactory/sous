import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../../src/adapters/exec.js";
import { repoEntries, repoNameOf } from "../../src/config/repos.js";
import { DEFAULT_SETTINGS, parseSettings } from "../../src/config/settings.js";
import { validateProject } from "../../src/config/validate.js";

/** A home repository at `<tmp>/home` whose `.sous/sous.yaml` is `yaml`, with sibling checkouts `a` and `b` holding a project. */
const workspace = (yaml: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sous-repos-"));
  for (const repo of ["a", "b"]) {
    mkdirSync(join(dir, repo, ".sous"), { recursive: true });
    writeFileSync(join(dir, repo, ".sous", "sous.yaml"), "");
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

  it("reports a repos entry that is not a string", () => {
    const { root } = workspace("repos: { a: ../a, b: [../b] }\n");
    expect(validateProject(root).errors.map((e) => [e.rule, e.message])).toEqual([["settings", 'repos.b must be a path, not ["../b"]']]);
  });

  it("reports two list entries named by the same folder", () => {
    const { root } = workspace("repos: [../a, ../x/a]\n");
    expect(validateProject(root).errors.map((e) => e.message)).toContain("repos: two entries are named a; use a map to name them apart");
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
