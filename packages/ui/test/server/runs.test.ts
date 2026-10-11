import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRows, liveLocks, openProject, readLog, readRun } from "../../server/runs";
import { at, Log, session, tempProject, writeRun } from "../fixtures";

const dead = () => false;
const alive = () => true;

describe("listRows", () => {
  it("summarizes readable runs and reports unreadable ones with their error", async () => {
    const root = tempProject();
    writeRun(root, "84", session(), new Log().start("r1", 0).visit("init", 0, 1, true, "implement").end(1, "done"));
    writeRun(root, "68", JSON.stringify({ schemaVersion: 4, unit: 1 }));
    // Any folder is a run folder now that ids are the tracker's own; an empty one is an error row.
    mkdirSync(join(root, "runs", "proj-a.1"));
    const rows = await listRows(openProject(root, dead));
    expect(rows.map((r) => (r.kind === "run" ? [r.summary.issue, r.summary.outcome] : [r.issue, "error"])).sort()).toEqual([
      ["68", "error"],
      ["84", "done"],
      ["proj-a.1", "error"],
    ]);
    const error = rows.find((r) => r.kind === "error" && r.issue === "68");
    expect(error?.kind === "error" && error.error).toMatch(/^\/schemaVersion|must have required property/);
    expect(error?.kind === "error" && error.error).not.toContain(root);
  });

  it("is empty when the runs folder does not exist", async () => {
    const root = tempProject();
    writeFileSync(join(root, "sous.yaml"), "runsDir: elsewhere\n");
    expect(await listRows(openProject(root, dead))).toEqual([]);
  });
});

describe("liveLocks", () => {
  const lock = (root: string, issue: string, pid: number) => {
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(join(root, "locks", `${issue}.lock`), JSON.stringify({ pid, issue }));
  };

  it("are the locks only while their process lives, one per issue", async () => {
    const root = tempProject();
    expect(await liveLocks(openProject(root, alive))).toEqual([]);
    lock(root, "84", 4242);
    lock(root, "85", 4343);
    expect(await liveLocks(openProject(root, alive))).toEqual([
      { pid: 4242, issue: "84" },
      { pid: 4343, issue: "85" },
    ]);
    expect(await liveLocks(openProject(root, dead))).toEqual([]);
  });

  it("make every locked issue's run live at once", async () => {
    const root = tempProject();
    writeRun(root, "84", session(), new Log().start("r1", 0).visit("init", 0, undefined));
    writeRun(root, "85", session({ issue: "85" }), new Log().start("r2", 0).visit("init", 0, undefined));
    lock(root, "84", 4242);
    lock(root, "85", 4343);
    const project = openProject(root, alive);
    for (const issue of ["84", "85"]) {
      const read = await readRun(project, issue);
      expect(read.kind === "ok" && read.view.summary.outcome).toBe("running");
    }
    const rows = await listRows(project);
    expect(rows.map((r) => r.kind === "run" && r.summary.live)).toEqual([true, true]);
  });
});

describe("readRun", () => {
  it("reads the output events of the log into the trace", async () => {
    const root = tempProject();
    const log = new Log().start("r1", 0).visit("init", 0, 1, true, "implement");
    log.events.push({ type: "output", at: at(1), spanId: "r1-1", step: "init", iteration: 1, scope: "84", envelope: { summary: "stub", commits: [], output: { stub: true } }, eval: { ok: true, logTail: "" } });
    writeRun(root, "84", session(), log);
    const read = await readRun(openProject(root, dead), "84");
    expect(read.kind === "ok" && read.view.trace.map((r) => [r.step, r.outputs.map((o) => o.output)])).toEqual([["init", [{ stub: true }]]]);
  });

  it("is missing for an issue without a run folder", async () => {
    expect(await readRun(openProject(tempProject(), dead), "1")).toEqual({ kind: "missing" });
  });

  it("gives each node its step's kind and eval gate from stepsDir; a step that is not there has neither", async () => {
    const root = tempProject();
    const step = (name: string, files: Record<string, string>) => {
      mkdirSync(join(root, "steps", name), { recursive: true });
      for (const [file, text] of Object.entries(files)) writeFileSync(join(root, "steps", name, file), text);
    };
    step("init", { "step.yaml": "name: init\nrun:\n  module: ./run.ts\n", "run.ts": "export default async () => {};\n" });
    step("implement", { "step.yaml": "name: implement\nrun:\n  prompt: prompt.md\n  output: { type: object }\neval: { shell: \"true\" }\n", "prompt.md": "Do it.\n" });
    writeRun(root, "84", session(), new Log().start("r1", 0).visit("init", 0, 1, true, "implement"));
    const read = await readRun(openProject(root, dead), "84");
    expect(read.kind === "ok" && read.view.nodes.map(({ id, kind, evalGate }) => ({ id, kind, evalGate }))).toEqual([
      { id: "init", kind: "module", evalGate: undefined },
      { id: "implement", kind: "prompt", evalGate: true },
      { id: "merge", kind: undefined, evalGate: undefined },
    ]);
  });

  it("uses the flow file named by the session", async () => {
    const root = tempProject();
    writeRun(root, "84", session(), new Log().start("r1", 0).visit("init", 0, 1, true, "implement"));
    const read = await readRun(openProject(root, dead), "84");
    expect(read.kind === "ok" && read.view.nodes.map((n) => n.id)).toEqual(["init", "implement", "merge"]);
  });

  it("reports a missing flow file but still shows the visits", async () => {
    const root = tempProject();
    writeRun(root, "84", session({ flow: "gone" }), new Log().start("r1", 0).visit("init", 0, 1, true, "implement"));
    const read = await readRun(openProject(root, dead), "84");
    expect(read.kind === "ok" && read.view.flowError).toBeTruthy();
    expect(read.kind === "ok" && read.view.nodes.map((n) => n.id)).toEqual(["init"]);
  });

  it("retries a session caught half written", async () => {
    const root = tempProject();
    writeRun(root, "84", '{"schemaVersion": 5, "pipel', new Log());
    setTimeout(() => writeRun(root, "84", session()), 30);
    const read = await readRun(openProject(root, dead), "84");
    expect(read.kind).toBe("ok");
  });

  it("reports a session of another schema as an error", async () => {
    const root = tempProject();
    writeRun(root, "68", JSON.stringify({ schemaVersion: 4 }));
    expect((await readRun(openProject(root, dead), "68")).kind).toBe("error");
  });
});

describe("readLog", () => {
  const withLog = () => {
    const root = tempProject();
    mkdirSync(join(root, "logs", "84"), { recursive: true });
    writeFileSync(join(root, "logs", "84", "implement-1.log"), "line one\nline two\n");
    writeFileSync(join(root, "logs", "84", "a1b2c3d4-7-90-implement-1.2.log"), "retry\n");
    writeFileSync(join(root, "runs", "secret.log"), "outside");
    return openProject(root, dead);
  };

  it("reads the whole log, or what follows an offset", async () => {
    const project = withLog();
    expect(await readLog(project, "84", "implement-1.log")).toEqual({ kind: "ok", text: "line one\nline two\n", start: 0, size: 18 });
    expect(await readLog(project, "84", "implement-1.log", 9)).toEqual({ kind: "ok", text: "line two\n", start: 9, size: 18 });
  });

  it("reads span-scoped names and the flat names of older runs alike", async () => {
    const project = withLog();
    expect(await readLog(project, "84", "a1b2c3d4-7-90-implement-1.2.log")).toEqual({ kind: "ok", text: "retry\n", start: 0, size: 6 });
    expect(await readLog(project, "84", "implement-1.log")).toMatchObject({ kind: "ok", size: 18 });
  });

  it("reads a log that shrank below the offset whole again", async () => {
    expect(await readLog(withLog(), "84", "implement-1.log", 500)).toMatchObject({ start: 0, size: 18 });
  });

  it("refuses names that could leave the issue's log folder", async () => {
    const project = withLog();
    for (const name of ["../../runs/secret.log", "..", "a/b.log", "session.json", ".hidden.log", "a1b2c3d4-7/90-implement-1.log", "a1b2c3d4-7-90-..-1.log"]) {
      expect(await readLog(project, "84", name)).toEqual({ kind: "invalid" });
    }
    expect(await readLog(project, "84", "review-1.log")).toEqual({ kind: "missing" });
  });
});
