import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The agent instructions are read by Claude Code (CLAUDE.md, which imports
// AGENTS.md), Codex and Cursor (AGENTS.md directly). These checks keep them
// whole and in step.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

// Codex reads AGENTS.md only up to `project_doc_max_bytes`, 32 KiB by
// default, and silently drops the rest. Leave headroom under that.
const AGENTS_MAX_BYTES = 30_000;

test("AGENTS.md fits within Codex's default instruction size", () => {
  const bytes = Buffer.byteLength(read("AGENTS.md"));
  assert.ok(
    bytes <= AGENTS_MAX_BYTES,
    `AGENTS.md is ${bytes} bytes; keep it under ${AGENTS_MAX_BYTES} by moving reference material into docs/guides/`,
  );
});

test("CLAUDE.md imports AGENTS.md rather than copying it", () => {
  assert.match(read("CLAUDE.md"), /^@AGENTS\.md$/m);
});

test("every learnings file is routed from AGENTS.md and the learnings index", () => {
  const files = readdirSync(join(REPO, "docs/learnings"))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort();
  const agents = read("AGENTS.md");
  const index = read("docs/learnings/README.md");
  assert.deepEqual(
    {
      missingFromAgents: files.filter(
        (name) => !agents.includes(`docs/learnings/${name}`),
      ),
      missingFromIndex: files.filter((name) => !index.includes(`(${name})`)),
    },
    { missingFromAgents: [], missingFromIndex: [] },
  );
});

test("agent-facing examples reference resources by name, never by UUID", () => {
  const uuid =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const offenders = ["AGENTS.md", "docs/guides/resource-reference.md"].filter(
    (path) => uuid.test(read(path)),
  );
  assert.deepEqual(offenders, []);
});
