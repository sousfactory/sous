/** The JSON shapes of the API that are not the view model itself. */
import type { LockInfo } from "sous-factory/read";
import type { RunRow } from "./model.js";

export type RunsResponse = { repo: string; flows: string[]; rows: RunRow[]; live: LockInfo[] };
