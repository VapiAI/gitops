// Where a test fixture puts engine state: the same places the engine does.
// Fixtures that seed the pre-state/ layout on purpose live in
// state-layout.test.ts.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { baselinesDir, stateFilePath } from "../src/state-paths.ts";

/** state/<org>/state.json under `root`, with its folder created. */
export function stateFixturePath(root: string, org: string): string {
  const path = stateFilePath(root, org);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export { baselinesDir };
