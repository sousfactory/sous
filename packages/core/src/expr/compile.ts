/**
 * Flow expressions and prompt placeholders. `when:` and `${{ … }}` are plain
 * JavaScript compiled with `new Function`, so flows need no expression
 * language of their own; `{{name}}` in prompts is plain substitution.
 * Compiling evaluates nothing, which is why `validate` can check it safely.
 */
import { ExpressionError } from "../exec/errors.js";

/** `prepared` is set in routes only. */
export type Scope = { ctx: unknown; steps: unknown; res: unknown; result: unknown; prepared?: unknown };
export type Expression = (scope: Scope) => unknown;

export const compileCondition = (src: string): Expression => {
  let fn: (ctx: unknown, steps: unknown, res: unknown, result: unknown, prepared: unknown) => unknown;
  try {
    fn = new Function("ctx", "steps", "res", "result", "prepared", `return (${src}\n)`) as typeof fn;
  } catch (error: unknown) {
    throw new ExpressionError(src, error instanceof Error ? error.message : String(error));
  }
  return (scope) => fn(scope.ctx, scope.steps, scope.res, scope.result, scope.prepared);
};

const TEMPLATE = /\$\{\{([\s\S]*?)\}\}/g;

/** Objects and arrays as JSON, so a template does not render `[object Object]`. */
export const stringify = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

/**
 * When the whole string is one `${{ expr }}` its value is returned as is, so
 * an input can be an object or a number; otherwise every expression is
 * stringified into the surrounding text.
 */
export const compileTemplate = (str: string): Expression => {
  const whole = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/.exec(str);
  if (whole !== null) return compileCondition(whole[1] ?? "");
  const parts: Array<string | Expression> = [];
  let last = 0;
  for (const match of str.matchAll(TEMPLATE)) {
    parts.push(str.slice(last, match.index), compileCondition(match[1] ?? ""));
    last = match.index + match[0].length;
  }
  parts.push(str.slice(last));
  return (scope) => parts.map((p) => (typeof p === "string" ? p : stringify(p(scope)))).join("");
};

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

/** Context placeholders any prompt may use without declaring them. */
export const CTX_PLACEHOLDERS = ["ctx.issue.id", "ctx.issue.ref", "ctx.work.id", "ctx.work.ref", "ctx.worktree", "ctx.spec", "ctx.specDir", "ctx.skillsDir", "ctx.templatesDir"] as const;
export type CtxPlaceholder = (typeof CTX_PLACEHOLDERS)[number];
export type CtxValues = Partial<Record<CtxPlaceholder, unknown>>;

const isCtxPlaceholder = (name: string): name is CtxPlaceholder => (CTX_PLACEHOLDERS as readonly string[]).includes(name);

const PREPARED_PREFIX = "prepared.";

export const preparedName = (placeholder: string): string | undefined =>
  placeholder.startsWith(PREPARED_PREFIX) ? placeholder.slice(PREPARED_PREFIX.length) : undefined;

export const placeholdersOf = (prompt: string): Set<string> => new Set([...prompt.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ""));

export type PlaceholderMismatch = {
  /** Neither a declared input, a `ctx.*` value, nor a property of `prepare.output`. */
  undeclared: string[];
  /** Declared inputs without a placeholder. */
  unused: string[];
};

/**
 * Checks both directions so a typo in either the prompt or `step.yaml` is
 * caught. Prepared values are only checked one way, since the eval may be
 * the one that uses them.
 */
export const placeholderMismatch = (placeholders: ReadonlySet<string>, inputs: Iterable<string>, prepared: Iterable<string> = []): PlaceholderMismatch => {
  const declared = new Set(inputs);
  const preparable = new Set(prepared);
  const isPrepared = (p: string): boolean => {
    const name = preparedName(p);
    return name !== undefined && preparable.has(name);
  };
  return {
    undeclared: [...placeholders].filter((p) => !declared.has(p) && !isCtxPlaceholder(p) && !isPrepared(p)).sort(),
    unused: [...declared].filter((i) => !placeholders.has(i)).sort(),
  };
};

/**
 * An unknown or missing placeholder throws rather than sending the agent a
 * literal `{{name}}`. A prepared value renders empty, since `prepare` may
 * leave optional properties out.
 */
export const renderPlaceholders = (prompt: string, inputs: Record<string, unknown>, ctx: CtxValues = {}, prepared?: unknown): string =>
  prompt.replace(PLACEHOLDER, (_match, name: string) => {
    const preparedKey = preparedName(name);
    if (preparedKey !== undefined) {
      const value = typeof prepared === "object" && prepared !== null ? (prepared as Record<string, unknown>)[preparedKey] : undefined;
      return value === undefined || value === null ? "" : stringify(value);
    }
    const value = isCtxPlaceholder(name) ? ctx[name] : Object.hasOwn(inputs, name) ? inputs[name] : undefined;
    if (value === undefined) throw new ExpressionError(`{{${name}}}`, "placeholder has no value");
    return stringify(value);
  });
