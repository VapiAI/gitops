// The directory the engine works in: the repository that holds src/.
//
// Every module takes it from here, so the test suite can give the engine a
// temporary directory instead. tests/no-vapi-api.ts names the repository the
// suite runs in and a temporary directory to use in its place. Then nothing
// a test does through the engine, and no path a test derives from it, can
// reach that repository. A CLI a test starts from a copy of src/ elsewhere
// keeps working in its own copy.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function baseDir(): string {
  const own = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sandbox = process.env.VAPI_GITOPS_TEST_ROOT;
  if (sandbox) return own === process.env.VAPI_GITOPS_TEST_REPO ? sandbox : own;
  // Node's test runner sets this for every test file it runs. Without the
  // sandbox a test would read and write the real repository: refuse.
  if (process.env.NODE_TEST_CONTEXT)
    throw new Error(
      "The engine was loaded by a test without tests/no-vapi-api.ts, so it would work in this repository instead of a temporary directory. Run tests with `npm test` or `node --import tsx --import ./tests/no-vapi-api.ts --test <file>`.",
    );
  return own;
}
