/**
 * The generic run loop. It knows nothing about what a step does; everything
 * with a side effect comes in through ports.
 *
 * The session is persisted after every write to a step's record (visit open,
 * each agent call, visit end) and at each transition, so a crash loses at
 * most the call in flight. `span.open` and `iteration.agent.start` are
 * appended before the long call they announce, so a crash during the call
 * still leaves them in the log.
 */
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { logPath } from "../adapters/logs.js";
import { BLOCKED, DONE, TERMINALS, type LoadedEntry, type Flow } from "../config/flow.js";
import { isAgentic, type Step, type StepEval } from "../config/step.js";
import { compileCondition, compileTemplate, type Expression, type Scope } from "../expr/compile.js";
import type { Ctx, Envelope, EvalFn, EvalResult, Inputs, Issue, Prepared, PrepareFn, RunFn, Work } from "../index.js";
import type { EventLog } from "../ports/eventlog.js";
import type { Git } from "../ports/git.js";
import type { Tracker } from "../ports/tracker.js";
import type { AgentRequest, AgentResult, Sandbox } from "../ports/sandbox.js";
import type { AgentOutcome, Event, PendingEvent } from "../session/events.js";
import type { Persist } from "../session/store.js";
import { bumpIteration, clearBlocked, iterationOf, logTail, markWorkDone, setSpecDir, setWork, transition } from "../session/update.js";
import { buildCtx, ctxPlaceholders, type CtxWrites } from "./ctx.js";
import { AgentOutputError, AgentProcessError, SousError } from "./errors.js";
import { skillAudit, type SkillAuditor } from "../skills.js";
import { renderPrompt, retryPrompt } from "./prompt.js";
import { forgetPrepared, openVisit, scopeKey, stepsOf, updateVisit, type Session } from "./scope.js";
import { validator } from "../config/schema.js";

export type Logger = { info: (line: string) => void; warn: (line: string) => void };

export type ExecutorPorts = {
  issue: Issue;
  /** `ctx.work` at start: the session's work item resolved to its issue. */
  work: Work;
  sandbox: Sandbox;
  git: Git;
  tracker: Tracker;
  events: EventLog;
  persist: Persist;
  clock: () => Date;
  /** Absolute paths. */
  skillsDir: string;
  logsDir: string;
  /** Fallback for the span's head sha once a step has removed the worktree. */
  repoRoot: string;
  /** Called after every transition; `to` is a step id, `done` or `blocked`. */
  onTransition: (session: Session, to: string) => Promise<void>;
  log: Logger;
  /** The run segment spans are opened in; span ids are `<runId>-<n>`. */
  runId?: string;
};

const PASS: EvalResult = { ok: true, log: "" };

/** What the log records for an iteration whose output did not validate. */
export const invalidOutputEnvelope = (error: AgentOutputError): Envelope => ({
  summary: `agent output did not validate: ${error.message}`,
  commits: [],
  output: null,
});

/** What the log records for an iteration whose agent process failed. */
export const agentFailureEnvelope = (error: AgentProcessError): Envelope => ({
  summary: `agent process failed: ${error.message}`,
  commits: [],
  output: null,
});

/** The iteration's eval log: the error plus the end of the agent log, so a retry sees why the process died. */
export const agentFailureLog = (error: AgentProcessError): string =>
  error.logTail !== undefined && error.logTail.trim() !== ""
    ? `${error.message}\n\n${error.logPath !== undefined ? `Agent log (${error.logPath}):` : "Agent log:"}\n${error.logTail}`
    : error.message;

type CompiledRoute = { to: string; when?: Expression };

/** Compiled once per run, so a syntax error fails the run before any step does work. */
type CompiledEntry = { with: Record<string, Expression>; resume?: Expression; routes: CompiledRoute[] };

const compileEntry = (entry: LoadedEntry): CompiledEntry => ({
  with: Object.fromEntries(Object.entries(entry.with).map(([name, value]) => [name, compileTemplate(value)])),
  ...(entry.resume !== undefined ? { resume: compileTemplate(entry.resume) } : {}),
  routes: entry.routes.map((r) => ({ to: r.to, ...(r.when !== undefined ? { when: compileCondition(r.when) } : {}) })),
});

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** An expression that throws is reported with the input it belongs to. */
export const evaluateWith = (id: string, templates: Record<string, Expression>, scope: Scope): Inputs =>
  Object.fromEntries(
    Object.entries(templates).map(([name, expr]) => {
      try {
        return [name, expr(scope)];
      } catch (error: unknown) {
        throw new SousError(`${id}: with.${name}: ${describe(error)}`);
      }
    }),
  );

/** A route without `when` always matches. */
export const firstMatch = (id: string, routes: readonly CompiledRoute[], scope: Scope): string => {
  const matched = routes.find((route, i) => {
    if (route.when === undefined) return true;
    try {
      return Boolean(route.when(scope));
    } catch (error: unknown) {
      throw new SousError(`${id}: routes[${i}].when: ${describe(error)}`);
    }
  });
  if (matched === undefined) throw new SousError(`${id}: no route matched`);
  return matched.to;
};

/** Anything that is not a non-empty string means a fresh session. */
const sessionIdOf = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Loaded through tsx so step modules can be plain TypeScript without a build. */
export const importDefault = async <T>(file: string): Promise<T> => {
  const mod = (await tsImport(pathToFileURL(file).href, import.meta.url)) as { default?: T };
  if (mod.default === undefined) throw new SousError(`${file}: no default export`);
  return mod.default;
};

const runEval = async (ev: StepEval, ctx: Ctx, inputs: Inputs, result?: Envelope, prepared?: Prepared): Promise<EvalResult> => {
  if (ev.kind === "shell") {
    const out = await ctx.exec(ev.shell);
    return { ok: out.code === 0, log: out.stdout + out.stderr };
  }
  const fn = await importDefault<EvalFn>(ev.module);
  return fn(ctx, inputs, result, prepared);
};

/** Validates a `prepare` module's return value, which comes from untyped step code. */
export const checkPrepared = (id: string, schema: Record<string, unknown>, value: unknown): Prepared => {
  const shape = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  const agent = shape?.["agent"];
  if (agent !== "run" && agent !== "skip") throw new SousError(`${id}: prepare must return { agent: "run" | "skip", output }; got agent ${JSON.stringify(agent)}`);
  const reason = shape?.["reason"];
  if (reason !== undefined && typeof reason !== "string") throw new SousError(`${id}: prepare reason must be a string`);
  const problem = validator(schema)(shape?.["output"]);
  if (problem !== undefined) throw new SousError(`${id}: prepare output does not match prepare.output: ${problem}`);
  return { agent, ...(reason !== undefined ? { reason } : {}), output: shape?.["output"] };
};

type VisitResult = {
  res: EvalResult;
  envelope?: Envelope;
  prepared?: Prepared;
  /** 0 when the re-entry eval settled the visit without an agent call. */
  iteration: number;
  exhausted: boolean;
};

type Attempt = {
  envelope: Envelope;
  sessionId?: string;
  res: EvalResult;
  /** No valid envelope came back; always retried, even with `loop: false`. */
  failed: boolean;
};

export const runFlow = async (flow: Flow, initial: Session, ports: ExecutorPorts): Promise<Session> => {
  const { sandbox, git, tracker, events, persist, clock, log } = ports;
  const runId = ports.runId ?? "";
  const byId = new Map(flow.steps.map((e) => [e.id, e]));
  const compiled = new Map(flow.steps.map((e) => [e.id, compileEntry(e)]));
  const { skillsDir } = ports;

  let session = initial;
  let work = ports.work;
  let spanCount = 0;
  let spanId = "";

  const deps = { issue: ports.issue, flow: flow.name, branch: session.branch, repoRoot: ports.repoRoot, skillsDir, sandbox, git, tracker, events };
  const ctxFor = (iteration?: number, writes?: CtxWrites): Ctx =>
    buildCtx(deps, { work, specDir: session.specDir, workProgress: session.workProgress, previous: session.previous, ...(iteration !== undefined ? { iteration } : {}) }, writes);
  const scopeFor = (ctx: Ctx, res?: EvalResult, result?: Envelope, prepared?: Prepared): Scope => ({ ctx, steps: stepsOf(session), res, result, prepared });
  const emit = (event: PendingEvent, at: Date = clock()): Promise<void> => events.append({ ...event, at: at.toISOString() } as Event);

  /** A step without `eval` passes without emitting eval events. */
  const evaluate = async (step: Step, inputs: Inputs, n: number, result?: Envelope, prepared?: Prepared): Promise<EvalResult> => {
    if (step.eval === undefined) return PASS;
    await emit({ type: "iteration.eval.start", spanId, n });
    const res = await runEval(step.eval, ctxFor(n), inputs, result, prepared);
    await emit({ type: "iteration.eval.end", spanId, n, ok: res.ok });
    return res;
  };

  const recordOutput = (step: string, key: string, iteration: number, envelope: Envelope, res: EvalResult, sessionId?: string): Promise<void> =>
    emit({
      type: "output",
      spanId,
      step,
      iteration,
      scope: key,
      ...(sessionId !== undefined ? { sessionId } : {}),
      envelope,
      eval: { ok: res.ok, logTail: logTail(res.log) },
    });

  const headSha = async (): Promise<string | undefined> => {
    for (const cwd of [sandbox.worktreePath, ports.repoRoot]) {
      try {
        return await git.headSha(cwd);
      } catch {
        // try the next checkout
      }
    }
    return undefined;
  };

  /** Persists the session id at once, so a crash later in the visit can still resume it. */
  const afterAgentCall = async (id: string, key: string, sessionId: string | undefined): Promise<void> => {
    session = bumpIteration(session, id);
    if (sessionId !== undefined) session = updateVisit(session, id, { session: sessionId }, key);
    await persist(session);
  };

  /**
   * One agent call plus its eval. Agent output and process errors become a
   * failed iteration; anything else propagates. An `InterruptedError` also
   * propagates: the run is ending, so nothing is recorded and the counter
   * stays where it was.
   */
  const attempt = async (
    entry: LoadedEntry,
    key: string,
    inputs: Inputs,
    n: number,
    prompt: string,
    resumeSession: string | undefined,
    skills: SkillAuditor,
    prepared: Prepared | undefined,
  ): Promise<Attempt> => {
    const { agent, step } = entry;
    if (agent === undefined || step.run?.kind !== "prompt") throw new SousError(`${entry.id}: an agentic step needs an agent`);
    const request: AgentRequest = {
      agent,
      prompt,
      ...(resumeSession !== undefined ? { resumeSession } : {}),
      logPath: logPath(ports.logsDir, session.issue, { spanId, scope: key, step: entry.id, iteration: n }),
      outputSchema: step.run.output,
    };
    await emit({
      type: "iteration.agent.start",
      spanId,
      n,
      kind: agent.kind,
      model: agent.model,
      ...(resumeSession !== undefined ? { resumedSession: resumeSession } : {}),
      logPath: request.logPath,
    });

    let result: AgentResult;
    try {
      result = await sandbox.runAgent(request);
    } catch (error: unknown) {
      if (!(error instanceof AgentOutputError || error instanceof AgentProcessError)) throw error;
      const outcome: AgentOutcome = error instanceof AgentOutputError ? "invalid-output" : "process-failed";
      await emit({
        type: "iteration.agent.end",
        spanId,
        n,
        outcome,
        commits: [],
        ...(error.sessionId !== undefined ? { sessionId: error.sessionId } : {}),
        ...(error.logPath !== undefined ? { logPath: error.logPath } : {}),
      });
      await afterAgentCall(entry.id, key, error.sessionId);
      log.warn(`${entry.id}: ${error.message}`);
      const envelope = error instanceof AgentOutputError ? invalidOutputEnvelope(error) : agentFailureEnvelope(error);
      const failureLog = error instanceof AgentOutputError ? error.message : agentFailureLog(error);
      return { envelope, ...(error.sessionId !== undefined ? { sessionId: error.sessionId } : {}), res: { ok: false, log: failureLog }, failed: true };
    }

    const { envelope, sessionId, usage, logPath: path, toolCalls } = result;
    await emit({
      type: "iteration.agent.end",
      spanId,
      n,
      outcome: "ok",
      commits: envelope.commits,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(path !== undefined ? { logPath: path } : {}),
    });
    await afterAgentCall(entry.id, key, sessionId);
    const audit = await skills.check({ reported: envelope.skills, toolCalls, resumed: resumeSession !== undefined });
    if (audit !== undefined) {
      await emit({ type: "skills", spanId, n, ...audit });
      for (const problem of audit.problems) log.warn(`${entry.id}: skills: ${problem}`);
    }
    const res = await evaluate(step, inputs, n, envelope, prepared);
    return { envelope, ...(sessionId !== undefined ? { sessionId } : {}), res, failed: false };
  };

  /**
   * Modules change the run by writing to `ctx` (`workDone`, `work`,
   * `specDir`); this applies those writes to the session after the call.
   */
  const withWrites = async <T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> => {
    const done: { work: string; commits: readonly string[] }[] = [];
    const ctx = ctxFor(undefined, { workDone: (w, commits) => done.push({ work: w, commits }) });
    const value = await fn(ctx);
    for (const d of done) session = markWorkDone(session, d.work, d.commits);
    if (ctx.work !== work) {
      work = ctx.work;
      session = setWork(session, work.id);
    }
    if (ctx.specDir !== session.specDir) session = setSpecDir(session, ctx.specDir);
    return value;
  };

  /**
   * Runs once per visit and is persisted before the agent is called. A
   * continuing visit reuses the recorded result: running `prepare` again
   * would see the worktree the agent has since changed.
   */
  const prepareVisit = async (entry: LoadedEntry, key: string, inputs: Inputs): Promise<Prepared | undefined> => {
    const { prepare } = entry.step;
    if (prepare === undefined) return undefined;
    const recorded = session.scopes[key]?.[entry.id]?.prepared;
    if (recorded !== undefined) return recorded;
    await emit({ type: "prepare.start", spanId });
    const fn = await importDefault<PrepareFn>(prepare.module);
    const prepared = checkPrepared(entry.id, prepare.output, await withWrites((ctx) => fn(ctx, inputs)));
    session = updateVisit(session, entry.id, { prepared }, key);
    await persist(session);
    await emit({ type: "prepare.end", spanId, agent: prepared.agent, ...(prepared.reason !== undefined ? { reason: prepared.reason } : {}) });
    if (prepared.agent === "skip") log.info(`${entry.id}: agent skipped${prepared.reason !== undefined ? `: ${prepared.reason}` : ""}`);
    return prepared;
  };

  /**
   * A continuing visit (re-entry after `blocked`, or a rerun after a crash)
   * evals the recorded result first, as iteration 0, so work a human fixed
   * by hand is not redone. Without a session to resume, a retry sends the
   * original prompt again: a retry prompt alone would reach an agent that
   * never saw the task. When `prepare` skips the agent, the eval runs once
   * with no result; there is nothing to retry.
   */
  const runAgentic = async (entry: LoadedEntry, c: CompiledEntry, key: string, inputs: Inputs, continuing: boolean): Promise<VisitResult> => {
    const { step } = entry;
    const max = entry.maxIterations ?? step.maxIterations;
    const loop = entry.loop ?? step.loop;
    const prepared = await prepareVisit(entry, key, inputs);
    const withPrepared = prepared !== undefined ? { prepared } : {};
    if (prepared?.agent === "skip") {
      const n = continuing ? 0 : 1;
      return { res: await evaluate(step, inputs, n, undefined, prepared), ...withPrepared, iteration: n, exhausted: false };
    }
    const record = session.scopes[key]?.[entry.id];
    const prompt = renderPrompt(step, inputs, ctxPlaceholders(ctxFor()), prepared?.output);
    const skills = skillAudit(prompt, skillsDir);
    let iteration = iterationOf(session, entry.id);
    let resumeSession = continuing ? record?.session : sessionIdOf(c.resume?.(scopeFor(ctxFor())));
    let nextPrompt = prompt;
    let last: VisitResult | undefined;

    if (continuing) {
      const recorded: Envelope | undefined = record?.output !== undefined ? { summary: "", commits: record.commits, output: record.output } : undefined;
      const res = await evaluate(step, inputs, 0, recorded, prepared);
      last = { res, ...(recorded !== undefined ? { envelope: recorded } : {}), ...withPrepared, iteration: 0, exhausted: false };
      if (res.ok) return last;
      nextPrompt = resumeSession !== undefined ? retryPrompt(res.log) : prompt;
    }

    while (iteration < max) {
      iteration++;
      log.info(`${entry.id}: iteration ${iteration}/${max}`);
      const a = await attempt(entry, key, inputs, iteration, nextPrompt, resumeSession, skills, prepared);
      await recordOutput(entry.id, key, iteration, a.envelope, a.res, a.sessionId);
      last = { res: a.res, envelope: a.envelope, ...withPrepared, iteration, exhausted: false };
      if (a.res.ok) return last;
      if (!loop && !a.failed) return last;
      resumeSession = a.sessionId;
      nextPrompt = resumeSession !== undefined ? retryPrompt(a.res.log) : prompt;
    }

    return { ...(last ?? { res: { ok: false, log: "" }, ...withPrepared }), iteration, exhausted: true };
  };

  /** An eval-only step has no module; its eval then runs with no result. */
  const runModule = async (entry: LoadedEntry, inputs: Inputs): Promise<Envelope | undefined> => {
    const { step } = entry;
    if (step.run === undefined) return undefined;
    if (step.run.kind !== "module") throw new SousError(`${entry.id}: not a module step`);
    const run = await importDefault<RunFn>(step.run.module);
    return withWrites(async (ctx) => (await run(ctx, inputs)) ?? undefined);
  };

  const runDeterministic = async (entry: LoadedEntry, key: string, inputs: Inputs): Promise<VisitResult> => {
    const { step } = entry;
    const envelope = await runModule(entry, inputs);
    const res = await evaluate(step, inputs, 1, envelope);
    if (envelope !== undefined) await recordOutput(entry.id, key, 1, envelope, res);
    return { res, ...(envelope !== undefined ? { envelope } : {}), iteration: 1, exhausted: false };
  };

  while (!TERMINALS.includes(session.current)) {
    const entry = byId.get(session.current);
    const c = compiled.get(session.current);
    if (entry === undefined || c === undefined) throw new SousError(`flow "${flow.name}" has no step "${session.current}"`);

    // Re-entry after blocked and a rerun after a crash mid-visit continue the
    // visit, so `visits` is not counted again. A recorded `prepare` result
    // always belongs to the current visit (the transition into a step forgets
    // it), so a crash after prepare continues the visit too, but without the
    // eval-first of a visit whose agent has run.
    const reentry = session.blocked;
    const continuing = reentry || iterationOf(session, entry.id) > 0;
    if (reentry) session = clearBlocked(session);
    const key = scopeKey(session.work);
    const prepared = session.scopes[key]?.[entry.id]?.prepared !== undefined;
    if (!(continuing || prepared) || session.scopes[key]?.[entry.id] === undefined) session = openVisit(session, entry.id, key);
    log.info(`${entry.id}: start${continuing || prepared ? " (re-entry)" : ""}`);

    spanId = `${runId === "" ? "span" : runId}-${++spanCount}`;
    await emit({ type: "span.open", runId, spanId, step: entry.id, scope: key });
    await persist(session);

    const inputs = evaluateWith(entry.id, c.with, scopeFor(ctxFor()));
    const visit = isAgentic(entry.step) ? await runAgentic(entry, c, key, inputs, continuing) : await runDeterministic(entry, key, inputs);

    session = updateVisit(session, entry.id, { ok: visit.res.ok, log: visit.res.log, output: visit.envelope?.output, commits: visit.envelope?.commits ?? [] }, key);
    const next = visit.exhausted ? BLOCKED : firstMatch(entry.id, c.routes, scopeFor(ctxFor(visit.iteration), visit.res, visit.envelope, visit.prepared));
    if (!byId.has(next) && !TERMINALS.includes(next)) throw new SousError(`flow "${flow.name}" has no step "${next}"`);

    const head = await headSha();
    const at = clock();
    await emit({ type: "span.close", spanId, ok: visit.res.ok, next, ...(head !== undefined ? { headSha: head } : {}), scopeAfter: scopeKey(session.work) }, at);
    session = transition(session, entry.id, next, at, visit.res.ok);
    if (byId.has(next)) session = forgetPrepared(session, next);
    await persist(session);
    await ports.onTransition(session, next);
    log.info(`${entry.id} -> ${next}`);

    if (next === DONE || next === BLOCKED) break;
  }

  return session;
};
