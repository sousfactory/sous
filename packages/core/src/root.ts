/**
 * Finds the project root (`.sous/`): `SOUS_ROOT` when set, else the cwd when
 * it is that folder, else `<cwd>/.sous` when it exists. Shared by the CLI and
 * the viewers so both agree on the same project.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const PROJECT_DIR = ".sous";

export const projectRoot = (cwd: string, env: NodeJS.ProcessEnv = process.env): string => {
  if (env["SOUS_ROOT"] !== undefined && env["SOUS_ROOT"] !== "") return resolve(env["SOUS_ROOT"]);
  if (basename(cwd) === PROJECT_DIR) return cwd;
  const nested = join(cwd, PROJECT_DIR);
  return existsSync(nested) ? nested : cwd;
};

/** The project folder always sits at the top of the repository it works on. */
export const repoRootOf = (root: string): string => dirname(root);
