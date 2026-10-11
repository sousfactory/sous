/**
 * Every visit of the run, oldest first, under the graph: step, duration,
 * what it returned and where it went next. Outputs follow each step's own
 * schema, so they are drawn generically: an object as fields, a list of
 * objects as a small table, a list of values inline, long text clamped.
 */
import { ArrowRightIcon } from "@primer/octicons-react";
import type { TraceOutput, TraceRow } from "../../server/model";
import { elapsed, shortSha } from "../format";
import { StatusIcon } from "./StatusIcon";

/** Past this, a string is shown clamped with the rest behind a toggle. */
const LONG_TEXT = 160;
const MAX_INLINE_ITEMS = 12;
const MAX_COLUMNS = 6;
/** Nesting deeper than this is shown as JSON. */
const MAX_DEPTH = 2;

const SEVERITY_COLOR: Record<string, string> = {
  blocker: "var(--fgColor-danger)",
  critical: "var(--fgColor-danger)",
  error: "var(--fgColor-danger)",
  major: "var(--fgColor-danger)",
  minor: "var(--fgColor-attention)",
  warning: "var(--fgColor-attention)",
  nit: "var(--fgColor-muted)",
  info: "var(--fgColor-muted)",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);
const SHA = /^[0-9a-f]{40}$/;

const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-fg-muted">{children}</span>;

/** Long or multi-line text: the first lines, the whole of it on a click. */
export const Text = ({ text }: { text: string }) => {
  if (text.length <= LONG_TEXT && !text.includes("\n")) return <span className="break-words">{text}</span>;
  const head = text.split("\n")[0]?.slice(0, LONG_TEXT) ?? "";
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer break-words">
        {head}
        <Muted> … more</Muted>
      </summary>
      <pre className="m-0 mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded bg-canvas-inset p-2 font-mono text-[12px]">{text}</pre>
    </details>
  );
};

const Primitive = ({ value, field }: { value: unknown; field?: string }) => {
  if (value === null || value === undefined) return <Muted>–</Muted>;
  if (typeof value === "boolean") return <code className="font-mono text-[12px]">{String(value)}</code>;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  const text = String(value);
  const severity = field === "severity" || field === "level" ? SEVERITY_COLOR[text.toLowerCase()] : undefined;
  if (severity !== undefined) return <span style={{ color: severity, fontWeight: 600 }}>{text}</span>;
  if (SHA.test(text)) return <code className="font-mono text-[12px]" title={text}>{shortSha(text)}</code>;
  return <Text text={text} />;
};

const Json = ({ value }: { value: unknown }) => <Text text={JSON.stringify(value, null, 2)} />;

/** A list of objects, one row each; columns in order of first appearance. */
const ObjectTable = ({ rows, depth }: { rows: Record<string, unknown>[]; depth: number }) => {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, MAX_COLUMNS);
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} className="border-b border-line-muted py-[2px] pr-3 text-left font-normal text-fg-muted">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="align-top">
            {columns.map((c) => (
              <td key={c} className="border-b border-line-muted py-[2px] pr-3 last:pr-0">
                <Value value={row[c]} field={c} depth={depth + 1} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** Any JSON value, as readable as its shape allows. */
export const Value = ({ value, field, depth = 0 }: { value: unknown; field?: string; depth?: number }) => {
  if (isPrimitive(value) || value === undefined) return <Primitive value={value} {...(field !== undefined ? { field } : {})} />;
  if (depth > MAX_DEPTH) return <Json value={value} />;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Muted>none</Muted>;
    if (value.every(isPrimitive)) {
      const shown = value.slice(0, MAX_INLINE_ITEMS);
      return (
        <span className="inline-flex flex-wrap gap-1">
          {shown.map((v, i) => (
            <code key={i} className="rounded bg-canvas-muted px-1 font-mono text-[12px]">
              {String(v)}
            </code>
          ))}
          {value.length > shown.length ? <Muted>+{value.length - shown.length} more</Muted> : null}
        </span>
      );
    }
    if (value.every(isRecord)) return <ObjectTable rows={value} depth={depth} />;
    return <Json value={value} />;
  }
  if (isRecord(value)) return <Fields value={value} depth={depth} />;
  return <Json value={value} />;
};

/** An object as `key  value` lines. */
export const Fields = ({ value, depth = 0 }: { value: Record<string, unknown>; depth?: number }) => {
  const entries = Object.entries(value);
  if (entries.length === 0) return <Muted>{"{}"}</Muted>;
  return (
    <div className="grid min-w-0 gap-x-3 gap-y-[2px]" style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}>
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <span className="font-mono text-[12px] leading-[20px] text-fg-muted">{k}</span>
          <div className="min-w-0">
            <Value value={v} field={k} depth={depth + 1} />
          </div>
        </div>
      ))}
    </div>
  );
};

/** One iteration's result: the agent's summary, the output, and the eval's log when it failed. */
const OutputBlock = ({ out }: { out: TraceOutput }) => (
  <div className="flex min-w-0 flex-col gap-1">
    {out.summary !== "" ? <div className="break-words">{out.summary}</div> : null}
    {out.output !== undefined ? <Value value={out.output} /> : null}
    {out.commits.length > 0 ? (
      <div className="text-[12px] text-fg-muted">
        commits: <span className="font-mono">{out.commits.map(shortSha).join(", ")}</span>
      </div>
    ) : null}
    {!out.eval.ok ? (
      <div className="text-[12px]">
        <div className="font-semibold text-fg-danger">eval failed</div>
        {out.eval.logTail !== "" ? <Text text={out.eval.logTail} /> : null}
      </div>
    ) : null}
  </div>
);

const Result = ({ row }: { row: TraceRow }) => {
  const latest = row.outputs[row.outputs.length - 1];
  const earlier = row.outputs.slice(0, -1);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {row.agentSkipped !== undefined ? (
        <div className="text-[12px] text-fg-muted">agent skipped{row.agentSkipped.reason !== undefined ? `: ${row.agentSkipped.reason}` : ""}</div>
      ) : null}
      {earlier.map((out) => (
        <details key={out.iteration} className="text-[12px]">
          <summary className="cursor-pointer text-fg-muted">
            iteration {out.iteration}: {out.eval.ok ? "eval passed" : <span className="text-fg-danger">eval failed</span>}
            {out.summary !== "" ? ` · ${out.summary.length > 80 ? `${out.summary.slice(0, 80)}…` : out.summary}` : ""}
          </summary>
          <div className="mt-1 border-l-2 border-line pl-2">
            <OutputBlock out={out} />
          </div>
        </details>
      ))}
      {latest !== undefined ? (
        <OutputBlock out={latest} />
      ) : row.status === "in_progress" ? (
        <Muted>running…</Muted>
      ) : row.agentSkipped === undefined && row.error === undefined ? (
        <Muted>no output recorded</Muted>
      ) : null}
      {row.error !== undefined ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] text-fg-danger">{row.error}</pre> : null}
    </div>
  );
};

export type RunTraceProps = { rows: TraceRow[]; now: number; stepHref: (step: string) => string; onOpen: (step: string, event: React.MouseEvent) => void };

export const RunTrace = ({ rows, now, stepHref, onOpen }: RunTraceProps) => {
  const scopes = new Set(rows.map((r) => r.scope));
  const showScope = scopes.size > 1;
  return (
    <div className="mt-6 overflow-hidden rounded-md border border-line" data-testid="run-trace">
      <div className="flex items-baseline gap-2 border-b border-line bg-canvas px-4 py-3">
        <span className="font-semibold">Steps</span>
        <span className="text-[12px] text-fg-muted">
          {rows.length} visit{rows.length === 1 ? "" : "s"}, oldest first
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-fg-muted">No step has run yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead className="bg-canvas-muted text-[12px] text-fg-muted">
              <tr>
                <th className="w-[1%] whitespace-nowrap px-4 py-2 text-left font-semibold">Step</th>
                {showScope ? <th className="w-[1%] whitespace-nowrap px-2 py-2 text-left font-semibold">Work</th> : null}
                <th className="w-[1%] whitespace-nowrap px-2 py-2 text-right font-semibold">Duration</th>
                <th className="px-4 py-2 text-left font-semibold">Result</th>
                <th className="w-[1%] whitespace-nowrap px-4 py-2 text-left font-semibold">Next</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.spanId} className="border-t border-line align-top" data-testid={`trace-${row.spanId}`}>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className="inline-flex items-center gap-2">
                      <StatusIcon status={row.status} />
                      <a href={stepHref(row.step)} onClick={(e) => onOpen(row.step, e)} className="font-semibold">
                        {row.step}
                      </a>
                      {row.visit > 1 ? <Muted>#{row.visit}</Muted> : null}
                    </span>
                  </td>
                  {showScope ? <td className="whitespace-nowrap px-2 py-2 text-[12px] text-fg-muted">#{row.scope}</td> : null}
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">
                    {elapsed(row.startedAt, row.endedAt, now)}
                    {row.iterations > 1 ? <div className="text-[12px] text-fg-muted">{row.iterations} iterations</div> : null}
                  </td>
                  <td className="min-w-[280px] px-4 py-2">
                    <Result row={row} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-[12px]">
                    {row.next !== undefined ? (
                      <span className="inline-flex items-center gap-1">
                        <ArrowRightIcon size={12} className="text-fg-muted" />
                        {row.next}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
