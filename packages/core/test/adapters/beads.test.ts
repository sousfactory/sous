import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../src/adapters/exec.js";
import { createBeadsTracker, labelsOf } from "../../src/adapters/beads.js";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

const A = "proj-a.1";
const B = "proj-b.2";
const bead = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Title of ${id}`,
  description: "What to do.",
  design: "How.",
  acceptance_criteria: "- it works",
  notes: "",
  issue_type: "bug",
  status: "open",
  ...overrides,
});

describe("beads adapter", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sous-beads-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** Scripts `bd show <id> --json` from `beads`; records every call. */
  const bdOf = (beads: Record<string, unknown>, extra: (args: readonly string[]) => ExecResult | undefined = () => undefined) => {
    const calls: string[][] = [];
    const exec: Exec = async (command, args, options) => {
      expect(options?.cwd).toBe("/repo");
      if (command === "git") return ok("Ada\n");
      expect(command).toBe("bd");
      calls.push([...args]);
      const scripted = extra(args);
      if (scripted !== undefined) return scripted;
      const [verb, id, flag] = args;
      if (verb !== "show" || flag !== "--json" || id === undefined) return fail(`unexpected: ${args.join(" ")}`);
      const found = beads[id];
      return found === undefined ? ok(JSON.stringify({ error: `no issue found matching "${id}"` })) : ok(JSON.stringify([found]));
    };
    return { beads: createBeadsTracker({ dir, cwd: "/repo", exec, clock: () => new Date("2026-10-08T12:00:00Z") }), calls };
  };

  it("reads the issue live from bd: title, the bead's text as the body, its type and id as labels, its state", async () => {
    const { beads } = bdOf({ [A]: bead(A) });
    expect(await beads.getIssue(A)).toEqual({
      id: A,
      ref: A,
      title: `Title of ${A}`,
      body: "What to do.\n\n## Design\n\nHow.\n\n## Acceptance Criteria\n\n- it works",
      labels: ["type:bug", `bead:${A}`],
      state: "open",
    });
  });

  it("keeps bd's own labels and adds the flows' type label and the bead id", () => {
    expect(labelsOf(bead(A, { issue_type: "task", labels: ["jira:ONE-1", "needs-planning"] }))).toEqual(["jira:ONE-1", "needs-planning", "type:task", `bead:${A}`]);
    expect(labelsOf(bead(A, { issue_type: "task" }))).toEqual(["type:task", `bead:${A}`]);
    expect(labelsOf(bead(A, { issue_type: "chore" }))).toEqual(["type:task", `bead:${A}`]);
    expect(labelsOf(bead(A, { issue_type: "feature" }))).toEqual(["type:feature", `bead:${A}`]);
    expect(labelsOf(bead(A, { issue_type: "epic" }))).toEqual(["type:feature", `bead:${A}`]);
  });

  it("sees a bead closed in bd as closed, and reading never writes", async () => {
    const { beads, calls } = bdOf({ [A]: bead(A, { status: "closed" }) });
    expect(await beads.isClosed(A)).toBe(true);
    expect(calls).toEqual([["show", A, "--json"]]);
  });

  it("claims under the git user and the run's branch, blocks with the label and a comment, closes with the reason", async () => {
    const { beads, calls } = bdOf({ [A]: bead(A) }, (args) => (args[0] === "update" || args[0] === "--actor" || args[0] === "close" ? ok("") : undefined));
    await beads.claim(A, { branch: "sous/a-1" });
    expect(calls.at(-1)).toEqual(["--actor", "Ada (sous:sous/a-1)", "update", A, "--claim"]);
    await beads.block(A, "Blocked in `fix`.");
    expect(calls.at(-1)).toEqual(["update", A, "--add-label", "sous:blocked"]);
    expect(await readFile(join(dir, A, "comments.md"), "utf8")).toContain("Blocked in `fix`.");
    await beads.close(A, "Merged.");
    expect(calls.at(-1)).toEqual(["close", A, "--reason", "Merged."]);
    await beads.close(A);
    expect(calls.at(-1)).toEqual(["close", A, "--reason", "closed by sous"]);
  });

  it("setStateLabel swaps the prefixed label in bd and skips a label already in place", async () => {
    const { beads, calls } = bdOf({ [A]: bead(A) }, (args) => (args[0] === "update" ? ok("") : undefined));
    await beads.setStateLabel(A, "sous:merged");
    expect(calls.at(-1)).toEqual(["update", A, "--add-label", "sous:merged"]);
    calls.length = 0;
    await beads.setStateLabel(A, "type:bug");
    expect(calls).toEqual([["show", A, "--json"]]);
  });

  it("writes comments into the run folder, never to bd", async () => {
    const { beads, calls } = bdOf({ [A]: bead(A) });
    calls.length = 0;
    await beads.comment(A, "Merged.");
    expect(await readFile(join(dir, A, "comments.md"), "utf8")).toBe("## 2026-10-08T12:00:00.000Z\n\nMerged.\n\n");
    expect(calls).toEqual([]);
  });

  it("lists an epic's beads as children by priority then age, names a bead's parent, and reads open blocks edges as blockers", async () => {
    const epic = "proj-e.1";
    const kids = [
      bead("proj-e.1.2", { priority: 1, created_at: "2026-10-07T19:55:48Z" }),
      bead("proj-e.1.1", { priority: 1, created_at: "2026-10-07T19:55:42Z", parent: epic }),
      bead("proj-e.1.3", { priority: 0, created_at: "2026-10-07T19:55:55Z" }),
    ];
    const deps = [
      { id: epic, dependency_type: "parent-child", status: "open" },
      { id: "proj-e.1.1", dependency_type: "blocks", status: "closed" },
      { id: "proj-e.1.2", dependency_type: "blocks", status: "open" },
    ];
    const { beads, calls } = bdOf({ [epic]: bead(epic, { issue_type: "epic" }), "proj-e.1.1": kids[1], "proj-e.1.3": bead("proj-e.1.3", { dependencies: deps }) }, (args) =>
      args[0] === "list" ? ok(JSON.stringify(kids)) : undefined,
    );
    expect(await beads.children(epic)).toEqual(["proj-e.1.3", "proj-e.1.1", "proj-e.1.2"]);
    expect(calls.at(-1)).toEqual(["list", "--parent", epic, "--all", "-n", "0", "--json"]);
    expect(await beads.parent("proj-e.1.1")).toBe(epic);
    expect(await beads.parent(epic)).toBeUndefined();
    expect(await beads.blockers("proj-e.1.3")).toEqual(["proj-e.1.2"]);
    expect(await beads.blockers(epic)).toEqual([]);
  });

  it("refuses an id bd does not know", async () => {
    const { beads } = bdOf({});
    await expect(beads.getIssue(A)).rejects.toThrow(`beads: no bead ${A}`);
  });

  it("fails loudly when bd itself fails", async () => {
    const { beads } = bdOf({}, () => fail("connection refused"));
    await expect(beads.getIssue(A)).rejects.toThrow(/bd show proj-a\.1 failed \(exit 1\): connection refused/);
  });
});
