import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEngine, ENGINE_VERSION, engineRangeOf, initialRange } from "../../src/config/engine.js";

describe("checkEngine", () => {
  it("accepts an engine inside the range", () => {
    expect(checkEngine("0.9.2", "^0.9.0", "/work/app")).toEqual({ kind: "satisfied" });
  });

  it("refuses an engine outside the range, naming engine, range and repository", () => {
    const check = checkEngine("0.9.0", "^0.8.0", "/work/app");
    expect(check).toEqual({ kind: "unsatisfied", message: "engine 0.9.0 does not satisfy engine: ^0.8.0 of /work/app" });
  });

  it("reports a missing range, naming the key and the repository", () => {
    expect(checkEngine("0.9.0", undefined, "/work/app")).toEqual({ kind: "missing", message: "/work/app states no engine: range in sous.yaml" });
  });

  it("reports a range that is no semver range, naming the value", () => {
    expect(checkEngine("0.9.0", "nonsense", "/work/app")).toEqual({ kind: "invalid", message: 'engine: "nonsense" is not a semver range' });
  });
});

describe("initialRange", () => {
  it("is a caret on the exact version, a prerelease tag included, so the engine that wrote it satisfies it", () => {
    expect(initialRange("0.9.0")).toBe("^0.9.0");
    expect(initialRange("1.2.3-rc.1")).toBe("^1.2.3-rc.1");
    expect(checkEngine("1.2.3-rc.1", initialRange("1.2.3-rc.1"), "/work/app")).toEqual({ kind: "satisfied" });
  });
});

describe("ENGINE_VERSION", () => {
  it("is the version of the sous-factory package", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });
});

describe("engineRangeOf", () => {
  const project = (yaml?: string): string => {
    const root = mkdtempSync(join(tmpdir(), "sous-engine-"));
    if (yaml !== undefined) writeFileSync(join(root, "sous.yaml"), yaml);
    return root;
  };

  it("reads engine: alone, tolerating keys this engine does not know", () => {
    expect(engineRangeOf(project("engine: ^0.9.0\nsomethingNewer: true\n"))).toBe("^0.9.0");
  });

  it("is undefined without the key or without the file", () => {
    expect(engineRangeOf(project("tracker: local\n"))).toBeUndefined();
    expect(engineRangeOf(project())).toBeUndefined();
  });
});

describe("checkEngine on a prerelease engine", () => {
  it("satisfies a caret range below its own base version", () => {
    expect(checkEngine("1.3.0-rc.1", "^1.2.0", "/work/app")).toEqual({ kind: "satisfied" });
  });

  it("does not satisfy a caret range on its own base version, which it precedes", () => {
    expect(checkEngine("1.2.0-rc.1", "^1.2.0", "/work/app").kind).toBe("unsatisfied");
  });
});
