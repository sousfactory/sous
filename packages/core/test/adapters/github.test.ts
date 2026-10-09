import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../../src/adapters/exec.js";
import { createGitHubTracker, isTransient, parseBlockedBy, toIssue } from "../../src/adapters/github.js";
import { labelPrefixOf, swapStateLabel } from "../../src/ports/tracker.js";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });

/** Scripts `gh` by a handler over its argument list; records every call. */
const ghOf = (handler: (args: readonly string[]) => ExecResult | string) => {
  const calls: string[][] = [];
  const slept: number[] = [];
  const warned: string[] = [];
  const exec: Exec = async (command, args) => {
    expect(command).toBe("gh");
    calls.push([...args]);
    const result = handler(args);
    return typeof result === "string" ? ok(result) : result;
  };
  const tracker = createGitHubTracker({
    exec,
    sleep: async (ms) => {
      slept.push(ms);
    },
    warn: (m) => warned.push(m),
  });
  return { tracker, calls, slept, warned };
};

const issueJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    number: 14,
    title: "Add export",
    body: "## Acceptance criteria\n- [ ] x\n\n## Blocked by\n- #12\n",
    labels: [{ name: "type:task" }, { name: "sous:running" }],
    state: "OPEN",
    ...overrides,
  });

describe("parseBlockedBy", () => {
  it("reads #n entries under the Blocked by section", () => {
    expect(parseBlockedBy("## Acceptance criteria\n- a\n\n## Blocked by\n- #12\n- #13\n\n## Notes\nsee #99")).toEqual(["12", "13"]);
    expect(parseBlockedBy("## Blocked by\n#7, #8")).toEqual(["7", "8"]);
  });

  it("treats None, an empty section and a missing section as no blockers", () => {
    expect(parseBlockedBy("## Blocked by\nNone\n")).toEqual([]);
    expect(parseBlockedBy("## Blocked by\n\n## Next\n#3")).toEqual([]);
    expect(parseBlockedBy("## Acceptance criteria\n- fixes #12")).toEqual([]);
  });

  it("is case-insensitive on the heading and ignores references elsewhere", () => {
    expect(parseBlockedBy("Closes #1\n\n## blocked BY\n- #2\n")).toEqual(["2"]);
  });
});

describe("swapStateLabel", () => {
  it("adds the new label and removes every other label of its prefix, whatever the prefix", () => {
    expect(swapStateLabel(["type:task", "sous:running", "sous:blocked"], "sous:merged")).toEqual({
      add: ["sous:merged"],
      remove: ["sous:running", "sous:blocked"],
      labels: ["type:task", "sous:merged"],
    });
    expect(swapStateLabel(["type:task", "factory:running", "sous:running"], "factory:blocked")).toEqual({
      add: ["factory:blocked"],
      remove: ["factory:running"],
      labels: ["type:task", "sous:running", "factory:blocked"],
    });
  });

  it("is a no-op when the label is already the only one of its prefix", () => {
    expect(swapStateLabel(["type:task", "sous:running"], "sous:running")).toEqual({ add: [], remove: [], labels: ["type:task", "sous:running"] });
  });

  it("removes nothing for a label without a prefix", () => {
    expect(labelPrefixOf("sous:running")).toBe("sous:");
    expect(labelPrefixOf("bug")).toBeUndefined();
    expect(swapStateLabel(["bug", "other"], "wip")).toEqual({ add: ["wip"], remove: [], labels: ["bug", "other", "wip"] });
  });
});

describe("toIssue", () => {
  it("flattens labels, defaults body and normalises state", () => {
    expect(toIssue({ number: 1, title: "t", body: null, labels: [{ name: "a" }], state: "CLOSED" })).toEqual({
      id: "1",
      ref: "#1",
      title: "t",
      body: "",
      state: "closed",
      labels: ["a"],
    });
    expect(toIssue({ number: 2, title: "t" }).state).toBe("open");
  });
});

describe("isTransient", () => {
  it("matches network and 5xx failures only", () => {
    expect(isTransient("HTTP 502: Bad Gateway (https://api.github.com/graphql)")).toBe(true);
    expect(isTransient("Post https://api.github.com: net/http: TLS handshake timeout")).toBe(true);
    expect(isTransient("API rate limit exceeded")).toBe(true);
    expect(isTransient("GraphQL: Could not resolve to an Issue with the number of 999.")).toBe(false);
    expect(isTransient("HTTP 404: Not Found")).toBe(false);
  });
});

describe("createGitHubTracker", () => {
  it("getIssue maps gh issue view --json", async () => {
    const { tracker, calls } = ghOf(() => issueJson());
    expect(await tracker.getIssue("#14")).toEqual({
      id: "14",
      ref: "#14",
      title: "Add export",
      body: "## Acceptance criteria\n- [ ] x\n\n## Blocked by\n- #12\n",
      state: "open",
      labels: ["type:task", "sous:running"],
    });
    expect(calls).toEqual([["issue", "view", "14", "--json", "number,title,body,labels,state"]]);
  });

  it("children pages the REST sub_issues endpoint and orders by number", async () => {
    const { tracker, calls } = ghOf(() => "13\n12\n\n14\n");
    expect(await tracker.children("10")).toEqual(["12", "13", "14"]);
    expect(calls[0]).toEqual(["api", "--paginate", "repos/{owner}/{repo}/issues/10/sub_issues", "--jq", ".[].number"]);
    const { tracker: empty } = ghOf(() => "");
    expect(await empty.children("10")).toEqual([]);
  });

  it("setStateLabel creates the label once, then adds it and removes the other prefixed labels in one edit", async () => {
    const { tracker, calls } = ghOf((args) =>
      args[0] === "issue" && args[1] === "view" ? issueJson({ labels: [{ name: "type:task" }, { name: "sous:running" }, { name: "sous:blocked" }] }) : "",
    );
    await tracker.setStateLabel("14", "sous:merged");
    expect(calls[1]).toEqual(["label", "create", "sous:merged", "--color", "0e8a16", "--description", "sous squashed the branch into main", "--force"]);
    expect(calls[2]).toEqual(["issue", "edit", "14", "--add-label", "sous:merged", "--remove-label", "sous:running", "--remove-label", "sous:blocked"]);
    await tracker.setStateLabel("14", "sous:merged");
    expect(calls.filter((c) => c[0] === "label")).toHaveLength(1);
  });

  it("claim sets <prefix>:running and block sets <prefix>:blocked with the comment", async () => {
    const { tracker, calls } = ghOf((args) => (args[0] === "issue" && args[1] === "view" ? issueJson({ labels: [{ name: "type:task" }] }) : ""));
    await tracker.claim("14", { branch: "feature/14-x" });
    expect(calls[1]).toEqual(["label", "create", "sous:running", "--color", "1d76db", "--description", "sous run in progress", "--force"]);
    expect(calls[2]).toEqual(["issue", "edit", "14", "--add-label", "sous:running"]);
    await tracker.block("14", "Blocked in `fix`.");
    expect(calls.at(-2)).toEqual(["issue", "edit", "14", "--add-label", "sous:blocked"]);
    expect(calls.at(-1)).toEqual(["issue", "comment", "14", "--body", "Blocked in `fix`."]);
  });

  it("setStateLabel skips the edit when the label is already in place", async () => {
    const { tracker, calls } = ghOf(() => issueJson({ labels: [{ name: "sous:running" }] }));
    await tracker.setStateLabel("14", "sous:running");
    expect(calls).toHaveLength(1);
  });

  it("comment, close and isClosed issue the expected gh calls", async () => {
    const { tracker, calls } = ghOf((args) => (args[1] === "view" ? issueJson({ state: "CLOSED" }) : ""));
    await tracker.comment("14", "hello");
    await tracker.close("14");
    await tracker.close("#14", "bye");
    expect(await tracker.isClosed("14")).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
      ["issue", "comment", "14", "--body", "hello"],
      ["issue", "close", "14"],
      ["issue", "comment", "14", "--body", "bye"],
      ["issue", "close", "14"],
    ]);
  });

  it("retries transient failures with backoff and then succeeds", async () => {
    let attempt = 0;
    const { tracker, calls, slept, warned } = ghOf(() => (++attempt < 3 ? fail("HTTP 502: Bad Gateway") : issueJson()));
    expect((await tracker.getIssue("14")).id).toBe("14");
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([2000, 4000]);
    expect(warned).toHaveLength(2);
  });

  it("gives up after the retries are exhausted", async () => {
    const { tracker, calls } = ghOf(() => fail("HTTP 503: Service Unavailable"));
    await expect(tracker.getIssue("14")).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(4);
  });

  it("throws immediately with stderr on a non-transient failure", async () => {
    const { tracker, calls, slept } = ghOf(() => fail("GraphQL: Could not resolve to an Issue with the number of 999."));
    await expect(tracker.getIssue("999")).rejects.toThrow(/gh issue view failed \(exit 1\): GraphQL: Could not resolve/);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  it("parent returns the parent id, undefined on 404, and throws otherwise", async () => {
    const { tracker, calls } = ghOf(() => "10\n");
    expect(await tracker.parent("14")).toBe("10");
    expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}/issues/14/parent", "--jq", ".number"]);

    const { tracker: orphan } = ghOf(() => fail("gh: Not Found (HTTP 404)"));
    expect(await orphan.parent("14")).toBeUndefined();

    const { tracker: broken } = ghOf(() => fail("gh: Forbidden (HTTP 403)"));
    await expect(broken.parent("14")).rejects.toThrow(/HTTP 403/);
  });

  it("blockers are the body's Blocked by entries that are still open", async () => {
    const { tracker } = ghOf((args) => (args[2] === "12" ? issueJson({ number: 12, state: "CLOSED" }) : issueJson({ body: "## Blocked by\n- #12\n- #13\n" })));
    expect(await tracker.blockers("14")).toEqual(["13"]);
  });
});
