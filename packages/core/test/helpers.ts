import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (...parts: string[]): string => join(fixtures, ...parts);

/** The valid fixture project's steps: the `stepsDir` its flows resolve against. */
export const projectSteps = fixture("project", "steps");
export const options = { stepsDir: projectSteps };

/** The invalid fixture's steps: its own broken ones beside copies of `build` and `merge`. */
export const invalidOptions = { stepsDir: fixture("invalid", "steps") };

export const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
