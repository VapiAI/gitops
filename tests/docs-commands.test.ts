import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The commands the docs tell people to run must exist: every `npm run <x>`
// is a package.json script, and every documented `--flag` is one the engine
// still knows. Renaming or removing a script or a flag fails here until the
// docs follow.

const REPO = fileURLToPath(new URL("..", import.meta.url));

// improvements.md is a historical log: its entries describe commands and
// flags as they were when each problem was found, and are never rewritten.
const HISTORICAL_DOCS = new Set(["improvements.md"]);

// Flags in the docs that belong to other tools (git, npm, node).
const EXTERNAL_FLAGS = new Set(["--allow-unrelated-histories"]);

function docFiles(): string[] {
  const files = readdirSync(REPO).filter(
    (name) => name.endsWith(".md") && !HISTORICAL_DOCS.has(name),
  );
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk("docs");
  walk("examples");
  return files.sort();
}

interface Mention {
  file: string;
  value: string;
}

function mentions(): { scripts: Mention[]; flags: Mention[] } {
  const scripts: Mention[] = [];
  const flags: Mention[] = [];
  for (const file of docFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const line of text.split("\n")) {
      for (const match of line.matchAll(/npm run ([a-z][a-z:-]*)/g))
        scripts.push({ file, value: match[1]! });
      // Flags written after `npm run …` on the same line.
      const start = line.indexOf("npm run ");
      if (start >= 0)
        for (const match of line
          .slice(start)
          .matchAll(/(?<![\w-])(--[a-z][a-z-]*[a-z])/g))
          flags.push({ file, value: match[1]! });
    }
    // Flags mentioned on their own in prose: `--overwrite`, `--resolve=ours`.
    for (const match of text.matchAll(/`(--[a-z][a-z-]*[a-z])(?:[= ][^`]*)?`/g))
      flags.push({ file, value: match[1]! });
  }
  return { scripts, flags };
}

function sourceText(): string {
  return readdirSync(join(REPO, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(REPO, "src", name), "utf8"))
    .join("\n");
}

const unique = (list: Mention[]) =>
  [...new Map(list.map((m) => [`${m.value} (${m.file})`, m])).keys()].sort();

test("every `npm run <script>` in the docs is a package.json script", () => {
  const scripts = Object.keys(
    JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts,
  );
  const { scripts: used } = mentions();
  assert.ok(
    used.length > 50,
    `expected many npm run mentions, found ${used.length}`,
  );
  assert.deepEqual(unique(used.filter((m) => !scripts.includes(m.value))), []);
});

test("every documented --flag is one the engine knows", () => {
  const source = sourceText();
  const { flags } = mentions();
  assert.ok(
    flags.length > 20,
    `expected many flag mentions, found ${flags.length}`,
  );
  assert.deepEqual(
    unique(
      flags.filter(
        (m) => !EXTERNAL_FLAGS.has(m.value) && !source.includes(m.value),
      ),
    ),
    [],
  );
});
