/** The project `review` eval: the blocking rule and its log. */
import { describe, expect, it } from "vitest";
import { ctxOf, envelope } from "sous-factory/testing";
import reviewEval from "../steps/review/eval.js";

const review = (findings: unknown[], verdict = findings.length === 0 ? "clean" : "findings") => envelope({ commits: [], output: { verdict, findings } });

describe("review eval", () => {
  it("passes a clean review with an empty log", async () => {
    expect(await reviewEval(ctxOf().ctx, {}, review([]))).toEqual({ ok: true, log: "" });
  });

  it("fails on blocker or major findings and lists only those, one per line, with line when given", async () => {
    const res = await reviewEval(
      ctxOf().ctx,
      {},
      review([
        { severity: "minor", file: "src/x.ts", line: 9, message: "small" },
        { severity: "blocker", file: "src/a.ts", line: 12, message: "wrong behaviour" },
        { severity: "major", file: "src/b.ts", message: "missing test" },
        { severity: "nit", file: "src/c.ts", message: "taste" },
      ]),
    );
    expect(res).toEqual({ ok: false, log: "blocker src/a.ts:12 wrong behaviour\nmajor src/b.ts missing test" });
  });

  it("passes when only minors and nits were reported, regardless of the verdict word", async () => {
    const res = await reviewEval(ctxOf().ctx, {}, review([{ severity: "minor", file: "src/x.ts", message: "small" }, { severity: "nit", file: "src/y.ts", message: "taste" }], "findings"));
    expect(res).toEqual({ ok: true, log: "" });
  });

  it("fails without a result", async () => {
    expect(await reviewEval(ctxOf().ctx, {}, undefined)).toEqual({ ok: false, log: "review: no review output" });
  });

  it("fails an output that is not a review, such as the null a failed agent call leaves, instead of reading it as clean", async () => {
    const notAReview = { ok: false, log: "review: the output is not a review (no findings array)" };
    expect(await reviewEval(ctxOf().ctx, {}, envelope({ commits: [], output: null }))).toEqual(notAReview);
    expect(await reviewEval(ctxOf().ctx, {}, envelope({ commits: [], output: { verdict: "clean" } }))).toEqual(notAReview);
  });
});
