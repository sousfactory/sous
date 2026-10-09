import { describe, expect, it } from "vitest";
import { ExpressionError } from "../../src/exec/errors.js";
import {
  compileCondition,
  compileTemplate,
  CTX_PLACEHOLDERS,
  placeholderMismatch,
  placeholdersOf,
  renderPlaceholders,
  stringify,
  type Scope,
} from "../../src/expr/compile.js";

const scope: Scope = {
  ctx: { issue: { id: "7", ref: "#7", title: "T", body: "B" }, previous: "review", skillsDir: "/s" },
  steps: { build: { visits: 1, ok: true, commits: ["abc", "def"], session: "s1" }, review: { visits: 3, ok: false, log: "bad" } },
  res: { ok: false, log: "nope" },
  result: { summary: "", commits: [], output: { conflict: true, work: null } },
};

describe("compileCondition", () => {
  it("evaluates JavaScript over ctx, steps, res and result", () => {
    expect(compileCondition("res.ok")(scope)).toBe(false);
    expect(compileCondition("!res.ok && steps.review.visits > 2")(scope)).toBe(true);
    expect(compileCondition("result.output.work != null")(scope)).toBe(false);
    expect(compileCondition('steps["build"].commits[0] + "^..HEAD"')(scope)).toBe("abc^..HEAD");
    expect(compileCondition("steps.fix?.session ?? steps.build.session")(scope)).toBe("s1");
    expect(compileCondition("ctx.previous === 'review' ? 'review' : 'verify'")(scope)).toBe("review");
  });

  it("sees the visit's prepare result as prepared, undefined when the scope has none", () => {
    expect(compileCondition("prepared?.agent === 'skip'")({ ...scope, prepared: { agent: "skip", output: {} } })).toBe(true);
    expect(compileCondition("prepared === undefined")(scope)).toBe(true);
  });

  it("compiles once; the function is reusable with another scope", () => {
    const fn = compileCondition("res.ok");
    expect(fn({ ...scope, res: { ok: true } })).toBe(true);
    expect(fn(scope)).toBe(false);
  });

  it("throws an ExpressionError carrying the source for a syntax error", () => {
    let caught: unknown;
    try {
      compileCondition("res.ok &&");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExpressionError);
    expect((caught as ExpressionError).source).toBe("res.ok &&");
    expect((caught as ExpressionError).message).toMatch(/cannot compile expression `res\.ok &&`: .*Unexpected token/);
  });

  it("does not let a trailing line comment swallow the closing paren", () => {
    expect(compileCondition("res.ok // comment")(scope)).toBe(false);
  });
});

describe("compileTemplate", () => {
  it("returns the raw value when the expression is the whole string", () => {
    expect(compileTemplate("${{ steps.build.commits }}")(scope)).toEqual(["abc", "def"]);
    expect(compileTemplate("  ${{ result.output.conflict }}\n")(scope)).toBe(true);
    expect(compileTemplate("${{ steps.fix?.session }}")(scope)).toBeUndefined();
  });

  it("stringifies embedded expressions into the surrounding text", () => {
    expect(compileTemplate("range ${{ steps.build.commits[0] }}^..HEAD, ok=${{ res.ok }}")(scope)).toBe("range abc^..HEAD, ok=false");
    expect(compileTemplate("${{ steps.build.commits }}!")(scope)).toBe('["abc","def"]!');
    expect(compileTemplate("n=${{ ctx.issue.id }}")(scope)).toBe("n=7");
  });

  it("returns a plain string unchanged", () => {
    expect(compileTemplate("./gradlew test")(scope)).toBe("./gradlew test");
    expect(compileTemplate("")(scope)).toBe("");
  });

  it("supports JS string literals with newlines inside the expression", () => {
    expect(compileTemplate('${{ ctx.issue.title + "\\n\\n" + ctx.issue.body }}')(scope)).toBe("T\n\nB");
  });

  it("throws an ExpressionError with the source of the failing expression", () => {
    expect(() => compileTemplate("x ${{ steps.build.commits[ }} y")).toThrow(ExpressionError);
    expect(() => compileTemplate("x ${{ steps.build.commits[ }} y")).toThrow("cannot compile expression ` steps.build.commits[ `");
  });
});

describe("stringify", () => {
  it("keeps strings, uses JSON for objects and String() otherwise", () => {
    expect(stringify("s")).toBe("s");
    expect(stringify({ a: 1 })).toBe('{"a":1}');
    expect(stringify([1, "x"])).toBe('[1,"x"]');
    expect(stringify(3)).toBe("3");
    expect(stringify(null)).toBe("null");
    expect(stringify(undefined)).toBe("undefined");
  });
});

describe("placeholdersOf", () => {
  it("collects every {{name}} including ctx.* and tolerates inner spaces", () => {
    expect([...placeholdersOf("a {{x}} b {{ y }} {{ctx.issue.id}} {{x}}")].sort()).toEqual(["ctx.issue.id", "x", "y"]);
  });

  it("ignores malformed names", () => {
    expect(placeholdersOf("{{ 1bad }} {{}} {{ a-b }} {{a b}}").size).toBe(0);
  });
});

describe("placeholderMismatch", () => {
  it("is empty when prompt and inputs agree, ignoring the five allowed ctx.* values", () => {
    expect(placeholderMismatch(new Set(["task", "verify", ...CTX_PLACEHOLDERS]), ["task", "verify"])).toEqual({ undeclared: [], unused: [] });
  });

  it("lists placeholders without input and inputs without placeholder", () => {
    expect(placeholderMismatch(new Set(["task", "ctx.specDir", "ctx.branch"]), ["verify", "task"])).toEqual({
      undeclared: ["ctx.branch"],
      unused: ["verify"],
    });
  });
});

describe("placeholderMismatch: prepared", () => {
  it("accepts {{prepared.<name>}} for a property of prepare.output and needs no placeholder for the others", () => {
    expect(placeholderMismatch(new Set(["task", "prepared.note"]), ["task"], ["note", "extra"])).toEqual({ undeclared: [], unused: [] });
  });

  it("lists a prepared placeholder that names no property, and every one without a prepare", () => {
    expect(placeholderMismatch(new Set(["prepared.nope", "prepared.note"]), [], ["note"])).toEqual({ undeclared: ["prepared.nope"], unused: [] });
    expect(placeholderMismatch(new Set(["prepared.note"]), [])).toEqual({ undeclared: ["prepared.note"], unused: [] });
  });
});

describe("renderPlaceholders", () => {
  it("fills {{prepared.*}} from the prepared output; a missing or null value, or no output at all, renders empty", () => {
    expect(renderPlaceholders("{{prepared.log}}|{{prepared.files}}|{{prepared.gone}}|{{prepared.none}}", {}, {}, { log: "red", files: ["a"], none: null })).toBe('red|["a"]||');
    expect(renderPlaceholders("[{{prepared.log}}]", {})).toBe("[]");
  });

  it("substitutes inputs and ctx values", () => {
    const out = renderPlaceholders("#{{ctx.issue.id}} in {{ ctx.worktree }}: {{task}} {{list}}", { task: "do it", list: [1, 2] }, { "ctx.issue.id": 7, "ctx.worktree": "/w" });
    expect(out).toBe('#7 in /w: do it [1,2]');
  });

  it("throws for a missing input or ctx value and for an input that only ctx may provide", () => {
    expect(() => renderPlaceholders("{{task}}", {})).toThrow("cannot compile expression `{{task}}`: placeholder has no value");
    expect(() => renderPlaceholders("{{ctx.specDir}}", {})).toThrow(/placeholder has no value/);
    expect(() => renderPlaceholders("{{ctx.specDir}}", { "ctx.specDir": "x" })).toThrow(/placeholder has no value/);
  });
});
