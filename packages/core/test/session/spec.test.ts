import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSpec, specFromIssue } from "../../src/session/spec.js";

const issue = { ref: "#7", title: "Add thing", body: "  We need a thing.\n" };

describe("specFromIssue", () => {
  it("is the title and the body as filed, nothing invented", () => {
    expect(specFromIssue(issue)).toBe("# Add thing\n\nWe need a thing.\n");
  });

  it("says so when the issue has no body", () => {
    expect(specFromIssue({ ...issue, body: "  " })).toBe("# Add thing\n\n_Issue #7 has no description._\n");
  });
});

describe("readSpec", () => {
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "sous-spec-"));
  });
  afterEach(() => rm(repoRoot, { recursive: true, force: true }));

  it("reads spec.md from the spec folder on the checkout as it is on disk", async () => {
    await mkdir(join(repoRoot, "specs/7-add-thing"), { recursive: true });
    await writeFile(join(repoRoot, "specs/7-add-thing/spec.md"), "# Planned\n\nby the plan session\n");
    expect(readSpec(repoRoot, "specs/7-add-thing", issue)).toEqual({ text: "# Planned\n\nby the plan session\n", source: "file" });
  });

  it("falls back to the issue when the folder or the file is missing", async () => {
    expect(readSpec(repoRoot, "specs/7-add-thing", issue)).toEqual({ text: "# Add thing\n\nWe need a thing.\n", source: "issue" });
    await mkdir(join(repoRoot, "specs/7-add-thing"), { recursive: true });
    expect(readSpec(repoRoot, "specs/7-add-thing", issue).source).toBe("issue");
  });
});
