import { describe, expect, it } from "vitest";
import { BLOCKING_SEVERITIES, findingsOf, formatFinding, isBlocking } from "../steps/review/findings.js";

describe("review findings", () => {
  it("blocker and major block; minor and nit do not", () => {
    expect([...BLOCKING_SEVERITIES]).toEqual(["blocker", "major"]);
    expect(isBlocking({ severity: "major", file: "a.ts", message: "m" })).toBe(true);
    expect(isBlocking({ severity: "nit", file: "a.ts", message: "m" })).toBe(false);
  });

  it("formats one line per finding, with the line when given", () => {
    expect(formatFinding({ severity: "minor", file: "src/a.ts", line: 3, message: "small thing" })).toBe("minor src/a.ts:3 small thing");
    expect(formatFinding({ severity: "nit", file: "src/b.ts", message: "taste" })).toBe("nit src/b.ts taste");
  });

  it("recognises a review output by its findings array and drops entries that are not findings", () => {
    expect(findingsOf({ verdict: "findings", findings: [{ severity: "major", file: "a", message: "m" }, { file: "b" }, "x"] })).toEqual([{ severity: "major", file: "a", message: "m" }]);
    expect(findingsOf({ verdict: "clean", findings: [] })).toEqual([]);
    expect(findingsOf({ ok: true })).toBeUndefined();
    expect(findingsOf(null)).toBeUndefined();
  });
});
