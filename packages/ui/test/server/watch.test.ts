import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeed, debouncer, issueOf, type Change, type Feed } from "../../server/watch";
import { tempProject } from "../fixtures";

describe("issueOf", () => {
  it("is the issue folder a path starts with", () => {
    expect(issueOf("84/session.json")).toBe("84");
    expect(issueOf("84")).toBe("84");
    expect(issueOf("proj-a.1/events.jsonl")).toBe("proj-a.1");
    expect(issueOf(".lock")).toBeNull();
    expect(issueOf("")).toBeNull();
  });
});

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("debouncer", () => {
  it("fires once per key after the burst settles", () => {
    vi.useFakeTimers();
    try {
      const fired: (number | null)[] = [];
      const d = debouncer<number | null>(150, (k) => fired.push(k));
      for (let i = 0; i < 5; i++) {
        d.push(84);
        vi.advanceTimersByTime(100);
      }
      d.push(null);
      expect(fired).toEqual([]);
      vi.advanceTimersByTime(150);
      expect(fired).toEqual([84, null]);
      d.push(84);
      d.cancel();
      vi.advanceTimersByTime(500);
      expect(fired).toEqual([84, null]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createFeed", () => {
  let feed: Feed | undefined;
  afterEach(() => feed?.close());

  const start = (root: string, liveness: () => Promise<string>, watchFiles: boolean) => {
    const changes: Change[] = [];
    feed = createFeed({ root, runsRoot: join(root, "runs"), logsRoot: join(root, "logs"), liveness, debounceMs: 50, pollMs: 100, watchFiles });
    feed.subscribe((c) => changes.push(c));
    return changes;
  };

  for (const watchFiles of [true, false]) {
    it(`reports the issue whose run or log changed (${watchFiles ? "fs.watch" : "mtime polling"})`, async () => {
      const root = tempProject();
      mkdirSync(join(root, "runs", "84"));
      mkdirSync(join(root, "logs", "84"));
      const changes = start(root, async () => "free", watchFiles);
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(join(root, "runs", "84", "session.json"), "{}");
      await until(() => changes.some((c) => c.issue === "84"));
      changes.length = 0;
      writeFileSync(join(root, "logs", "84", "implement-1.log"), "x");
      await until(() => changes.some((c) => c.issue === "84"));
    });
  }

  it("reports a change of liveness without any write", async () => {
    let state = "free";
    const changes = start(tempProject(), async () => state, false);
    await new Promise((r) => setTimeout(r, 150));
    state = "held";
    await until(() => changes.some((c) => c.issue === null));
  });
});
