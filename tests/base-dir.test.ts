import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The engine's directory comes from src/base-dir.ts and nowhere else. A
// module that worked it out for itself would work in the repository while
// every other module worked in a test's temporary directory.

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// A line that finds the module's own location, or the directory the command
// was started in.
const LOCATES =
  /import\.meta\.(url|dirname|filename)|\b__dirname\b|\b__filename\b|process\.cwd\(\)/;

// The lines allowed to: asking whether this file is the script being run,
// loading a CommonJS dependency, and src/user-agent.ts, the one deliberate
// exception. It reads the engine's own package.json for the version it
// sends, and in an engine test baseDir() is a temporary directory with no
// package.json in it.
function allowed(file: string, line: string): boolean {
  return (
    file === "base-dir.ts" ||
    line.includes("process.argv[1]") ||
    line.includes("createRequire(import.meta.url)") ||
    file === "user-agent.ts"
  );
}

test("no module under src/ works out the repository's directory for itself", () => {
  const found: string[] = [];
  for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts")) continue;
    readFileSync(join(SRC, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (LOCATES.test(line) && !allowed(file, line))
          found.push(`src/${file}:${index + 1}`);
      });
  }
  assert.deepEqual(found, []);
});
