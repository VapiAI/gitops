// The directory the engine works in: the repository that holds src/.
//
// Every module takes it from here. tests/base-dir.test.ts fails when one
// works it out for itself; src/user-agent.ts alone reads a file from where
// it sits, the engine's own package.json, and says why.
//
// The engine's own tests each import tests/engine-sandbox.ts first, which
// names the repository they run in and a temporary directory to use in its
// place. Then nothing such a test does through the engine, and no path it
// derives from it, can reach that repository. A command a test starts from
// a copy of src/ elsewhere keeps working in its own copy.
//
// Nothing else changes the answer. In particular the engine never asks
// whether a test runner is somewhere above it: a command run as a command,
// from a test of yours or anywhere else, works in the repository that holds
// its src/.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function baseDir(): string {
  const own = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sandbox = process.env.VAPI_GITOPS_TEST_ROOT;
  return sandbox && own === process.env.VAPI_GITOPS_TEST_REPO ? sandbox : own;
}
