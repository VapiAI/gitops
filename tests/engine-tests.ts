import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// An engine test is a test file whose first import is the sandbox,
// tests/engine-sandbox.ts. Any other test file in tests/ belongs to the
// repository it is in, and is left alone.
export const SANDBOX = 'import "./engine-sandbox.ts";';
// The same import from tests/repository/, which holds the engine tests that
// start a test runner of their own (`npm run test:repository`).
export const SANDBOX_FROM_FOLDER = 'import "../engine-sandbox.ts";';

function firstImport(path: string): string | undefined {
  return readFileSync(path, "utf8")
    .split("\n")
    .find((line) => /^import\b/.test(line));
}

export function testFiles(
  dir: string,
  sandbox = SANDBOX,
): { engine: string[]; other: string[] } {
  if (!existsSync(dir)) return { engine: [], other: [] };
  const names = readdirSync(dir).filter((name) => name.endsWith(".test.ts"));
  const engine = names.filter(
    (name) => firstImport(join(dir, name)) === sandbox,
  );
  return { engine, other: names.filter((name) => !engine.includes(name)) };
}
