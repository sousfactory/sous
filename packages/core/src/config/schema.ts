/**
 * The one place that touches ajv and the file system for configuration:
 * YAML reading and JSON Schema checking shared by settings, step and flow.
 */
import { existsSync, readFileSync } from "node:fs";
import { Ajv, type ErrorObject, type SchemaObject } from "ajv";
import { parse } from "yaml";
import { SousError } from "../exec/errors.js";

/** An empty file is `null`; so is a missing one when `optional`. */
export const readYaml = (file: string, optional = false): unknown => {
  if (optional && !existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error: unknown) {
    throw new SousError(`${file}: ${messageOf(error)}`);
  }
  try {
    return parse(text) ?? null;
  } catch (error: unknown) {
    throw new SousError(`${file}: invalid YAML: ${messageOf(error)}`);
  }
};

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const ajv = new Ajv({ allErrors: true });

const describe = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .map((e) => {
      const extra = e.keyword === "additionalProperties" ? ` (${String(e.params["additionalProperty"])})` : "";
      return `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? e.keyword}${extra}`;
    })
    .join("; ");

/** Throws a `SousError` naming the file and every violation, so one run fixes them all. */
export const checker = <T>(schema: SchemaObject): ((value: unknown, file: string) => T) => {
  const validate = ajv.compile<T>(schema);
  return (value, file) => {
    if (validate(value)) return value;
    throw new SousError(`${file}: ${describe(validate.errors)}`);
  };
};

/**
 * Returns the violations instead of throwing, for places where a failure is
 * data rather than an error: an agent envelope, a session file.
 */
export const validator = (schema: SchemaObject): ((value: unknown) => string | undefined) => {
  const validate = ajv.compile(schema);
  return (value) => (validate(value) ? undefined : describe(validate.errors));
};

/** Lets `validate` reject a broken output schema in a step before a run reaches it. */
export const schemaProblem = (schema: unknown): string | undefined => {
  try {
    new Ajv().compile(schema as SchemaObject);
    return undefined;
  } catch (error: unknown) {
    return messageOf(error);
  }
};
