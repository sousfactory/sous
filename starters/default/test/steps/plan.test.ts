import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentResult, ctxOf, envelope, fakeGit } from "sous-factory/testing";
import evaluate, { sectionItems } from "../../steps/plan/eval.js";
import prepare from "../../steps/plan/prepare.js";

const SPEC_DIR = "specs/1-test-issue";

const spec = (sections: string): string => `# Spec: Test issue\n\n- **Issue:** #1\n- **Status:** derived\n\n## Problem Statement\n\nDo the thing.\n\n${sections}`;

describe("plan", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "sous-plan-"));
  });
  afterEach(() => rm(worktree, { recursive: true, force: true }));

  const written = async (text: string): Promise<void> => {
    await mkdir(join(worktree, SPEC_DIR), { recursive: true });
    await writeFile(join(worktree, SPEC_DIR, "spec.md"), text);
  };

  it("prepare skips the agent when spec.md is already in the worktree, and runs it otherwise", async () => {
    const f = ctxOf({ worktree, specDir: SPEC_DIR });
    expect(await prepare(f.ctx, {})).toEqual({ agent: "always", output: { exists: false } });
    await written(spec("## Assumptions\n\n- None.\n"));
    expect(await prepare(f.ctx, {})).toEqual({ agent: "never", reason: `${SPEC_DIR}/spec.md is on the branch`, output: { exists: true } });
    expect(f.git.calls).toEqual([]);
  });

  it("eval fails without the file, naming where it has to be", async () => {
    const f = ctxOf({ worktree, specDir: SPEC_DIR });
    expect(await evaluate(f.ctx, {})).toEqual({ ok: false, log: `plan: no ${SPEC_DIR}/spec.md in the worktree; the spec must be written and committed there` });
  });

  it("eval passes a committed spec with assumptions and no open questions, counting the assumptions", async () => {
    await written(spec("## Assumptions\n\n- Exports are CSV only.\n- The file name is the portfolio name.\n\n## Open questions\n\n## Further Notes\n\nNone.\n"));
    const f = ctxOf({ worktree, specDir: SPEC_DIR });
    expect(await evaluate(f.ctx, {}, agentResult("s1", envelope({ output: { assumptions: 2, openQuestions: 0 } })).envelope)).toEqual({
      ok: true,
      log: `plan: ${SPEC_DIR}/spec.md is on the branch with 2 assumptions and no open questions`,
    });
    expect(f.git.calls).toEqual([`isDirty(${worktree})`]);
  });

  it("eval fails with the open questions as the log, so the blocked comment carries them", async () => {
    await written(spec("## Assumptions\n\n- None.\n\n## Open questions\n\n1. Soft-delete or hard-delete? I would soft-delete.\n- Is the export per user or per tenant?\n"));
    const f = ctxOf({ worktree, specDir: SPEC_DIR });
    expect(await evaluate(f.ctx, {})).toEqual({
      ok: false,
      log: [
        `plan: ${SPEC_DIR}/spec.md leaves 2 questions open. Answer them in the file (or in the issue body) and run the issue again:`,
        "- Soft-delete or hard-delete? I would soft-delete.",
        "- Is the export per user or per tenant?",
      ].join("\n"),
    });
  });

  it("eval fails when the agent left the spec uncommitted; a pre-existing file is not checked for that", async () => {
    await written(spec("## Assumptions\n\n- None.\n"));
    const git = fakeGit({ existing: ["main", "feature/1-test-issue"], branches: { [worktree]: "feature/1-test-issue" } });
    git.state.dirty.add(worktree);
    const f = ctxOf({ worktree, specDir: SPEC_DIR, git });
    expect(await evaluate(f.ctx, {}, envelope({ output: { assumptions: 0, openQuestions: 0 } }))).toEqual({
      ok: false,
      log: `plan: the worktree has uncommitted changes; commit ${SPEC_DIR}/spec.md on the branch`,
    });
    expect((await evaluate(f.ctx, {})).ok).toBe(true);
  });

  it("sectionItems reads one section's list items, whatever the marker, and nothing without the section", () => {
    const text = "## A\n\n- one\n* two\n3. three\nprose\n\n## B\n\n- four\n";
    expect(sectionItems(text, "A")).toEqual(["one", "two", "three"]);
    expect(sectionItems(text, "B")).toEqual(["four"]);
    expect(sectionItems(text, "C")).toEqual([]);
  });
});
