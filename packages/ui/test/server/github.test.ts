import { describe, expect, it } from "vitest";
import { createGitHubLookup, type Gh } from "../../server/github";

const SHA = "b2f04a5d78df04f2adc77a062964d5bcb15f2024";

const run = (name: string, status: string, conclusion: string | null, created: string) => ({
  name,
  html_url: `https://github.com/o/r/actions/runs/${name}-${created}`,
  status,
  conclusion,
  created_at: created,
  run_started_at: created,
  updated_at: created,
});

/** A scripted `gh`: the runs answer, then the commit answer; records every call. */
const scripted = (runs: unknown[] | Error, commit: string | Error = `https://github.com/o/r/commit/${SHA}\n`) => {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const answer = args[1]?.includes("/actions/runs") ? (runs instanceof Error ? runs : JSON.stringify({ workflow_runs: runs })) : commit;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { gh, calls };
};

describe("createGitHubLookup", () => {
  it("answers none without a squash commit and asks nothing", async () => {
    const { gh, calls } = scripted([]);
    expect(await createGitHubLookup(gh)(undefined)).toEqual({ state: "none" });
    expect(calls).toEqual([]);
  });

  it("lists the latest run of each workflow by name, final once all completed", async () => {
    const { gh } = scripted([
      run("deploy-ec2", "completed", "failure", "2026-10-05T10:00:00Z"),
      run("deploy-ec2", "completed", "success", "2026-10-05T10:05:00Z"),
      run("infra-deploy", "in_progress", null, "2026-10-05T10:01:00Z"),
    ]);
    const view = await createGitHubLookup(gh)(SHA);
    expect(view).toMatchObject({ state: "runs", sha: SHA, final: false });
    expect(view.state === "runs" && view.runs.map((r) => [r.workflow, r.status, r.conclusion])).toEqual([
      ["deploy-ec2", "completed", "success"],
      ["infra-deploy", "in_progress", undefined],
    ]);
  });

  it("links the commit when it is on GitHub but no workflow ran", async () => {
    expect(await createGitHubLookup(scripted([]).gh)(SHA)).toEqual({ state: "no-workflow", sha: SHA, commitUrl: `https://github.com/o/r/commit/${SHA}` });
  });

  it("calls a commit GitHub does not have unpushed, and any other gh failure unavailable", async () => {
    expect(await createGitHubLookup(scripted([], new Error(`gh: No commit found for SHA: ${SHA} (HTTP 422)`)).gh)(SHA)).toEqual({ state: "unpushed", sha: SHA });
    expect(await createGitHubLookup(scripted(new Error("gh: To get started with GitHub CLI, please run: gh auth login")).gh)(SHA)).toEqual({
      state: "unavailable",
      sha: SHA,
      error: "gh: To get started with GitHub CLI, please run: gh auth login",
    });
  });

  it("asks again after the ttl until every run completed, then never", async () => {
    let t = 0;
    let runs = [run("deploy-ec2", "in_progress", null, "2026-10-05T10:00:00Z")];
    const calls: string[][] = [];
    const gh: Gh = async (args) => (calls.push(args), JSON.stringify({ workflow_runs: runs }));
    const lookup = createGitHubLookup(gh, { ttlMs: 30_000, now: () => t });
    await lookup(SHA);
    t = 10_000;
    await lookup(SHA);
    expect(calls).toHaveLength(1);
    t = 40_000;
    runs = [run("deploy-ec2", "completed", "success", "2026-10-05T10:00:00Z")];
    expect(await lookup(SHA)).toMatchObject({ state: "runs", final: true });
    t = 1_000_000;
    await lookup(SHA);
    expect(calls).toHaveLength(2);
  });
});
