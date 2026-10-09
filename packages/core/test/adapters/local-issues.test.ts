import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commentsFile, createLocalTracker, issueFile } from "../../src/adapters/local-issues.js";

describe("local issues", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-issues-"));
    await writeFile(issueFile(dir, "7"), JSON.stringify({ id: "7", title: "Do it", body: "Body", labels: ["type:task"], state: "open", beadId: "x-1" }), "utf8");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const stored = async (id: string) => JSON.parse(await readFile(issueFile(dir, id), "utf8")) as Record<string, unknown>;

  it("reads an issue from its file; children, parent and blockers come from the children and blockedBy keys", async () => {
    const issues = createLocalTracker({ dir });
    expect(await issues.getIssue("7")).toEqual({ id: "7", ref: "7", title: "Do it", body: "Body", labels: ["type:task"], state: "open" });
    expect(await issues.parent("7")).toBeUndefined();
    expect(await issues.children("7")).toEqual([]);
    expect(await issues.blockers("7")).toEqual([]);

    await writeFile(issueFile(dir, "e"), JSON.stringify({ id: "e", title: "Epic", children: ["7", "8"] }), "utf8");
    await writeFile(issueFile(dir, "8"), JSON.stringify({ id: "8", title: "Second", blockedBy: ["7", "9"] }), "utf8");
    await writeFile(issueFile(dir, "9"), JSON.stringify({ id: "9", title: "Done", state: "closed" }), "utf8");
    expect(await issues.children("e")).toEqual(["7", "8"]);
    expect(await issues.parent("8")).toBe("e");
    expect(await issues.blockers("8")).toEqual(["7"]);
  });

  it("names the missing file and refuses a file holding another id", async () => {
    const issues = createLocalTracker({ dir });
    await expect(issues.getIssue("8")).rejects.toThrow(`${issueFile(dir, "8")} does not exist`);
    await writeFile(issueFile(dir, "9"), JSON.stringify({ id: "7", title: "x" }), "utf8");
    await expect(issues.getIssue("9")).rejects.toThrow("holds id 7, not 9");
  });

  it("swaps state labels and closes in the file, keeping unknown keys", async () => {
    const issues = createLocalTracker({ dir });
    await issues.claim("7", { branch: "feature/7-x" });
    await issues.setStateLabel("7", "sous:merged");
    await issues.close("7");
    expect(await stored("7")).toEqual({ id: "7", title: "Do it", body: "Body", labels: ["type:task", "sous:merged"], state: "closed", beadId: "x-1" });
    expect(await issues.isClosed("7")).toBe(true);
  });

  it("appends comments with a timestamp heading", async () => {
    const issues = createLocalTracker({ dir, clock: () => new Date("2026-10-07T10:00:00Z") });
    await issues.comment("7", "first");
    await issues.comment("7", "second");
    expect(await readFile(commentsFile(dir, "7"), "utf8")).toBe("## 2026-10-07T10:00:00.000Z\n\nfirst\n\n## 2026-10-07T10:00:00.000Z\n\nsecond\n\n");
  });
});
