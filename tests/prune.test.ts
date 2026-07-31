import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// prune.ts → config.ts, which process.exit(1)s at module load without a token
// and a slug-shaped argv[2]. Same preamble as tests/path-matching.test.ts.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const {
  classifyStaleTrackedResources,
  pruneStaleTrackedResources,
  warnStaleTrackedResources,
} = await import("../src/prune.ts");
type StaleTrackedResource = Awaited<
  ReturnType<typeof classifyStaleTrackedResources>
>[number];

// ─────────────────────────────────────────────────────────────────────────────
// Classification — facts (1)–(3) of the prune safety model. The disk and
// ignore lookups are injected so these run in-process with no resource tree.
// ─────────────────────────────────────────────────────────────────────────────

const noFiles = () => [];
const noIgnore = () => null;

function classify(
  options: Partial<Parameters<typeof classifyStaleTrackedResources>[0]>,
) {
  return classifyStaleTrackedResources({
    resourceType: "assistants",
    previousSection: {},
    newSection: {},
    liveUuids: new Set<string>(),
    resolveFiles: noFiles,
    ignoreMatcher: noIgnore,
    ...options,
  });
}

test("classify: tracked slug that vanished from state and dashboard is prunable", () => {
  const stale = classify({
    previousSection: { riley: { uuid: "uuid-riley" } },
    resolveFiles: () => ["/repo/resources/org/assistants/riley.md"],
  });

  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.resourceId, "riley");
  assert.equal(stale[0]?.uuid, "uuid-riley");
  assert.equal(stale[0]?.disposition, "prunable");
});

test("classify: a slug still tracked after the pull is never stale", () => {
  // Recreated or adopted on the dashboard under the same stable slug — the
  // file on disk is current, only the UUID behind it changed.
  const stale = classify({
    previousSection: { riley: { uuid: "old-uuid" } },
    newSection: { riley: { uuid: "new-uuid" } },
    liveUuids: new Set(["new-uuid"]),
    resolveFiles: () => ["/repo/resources/org/assistants/riley.md"],
  });

  assert.deepEqual(stale, []);
});

test("classify: a duplicate mapping whose UUID is still live is not stale", () => {
  // Two slugs pointed at one UUID; the pull collapsed them onto the survivor.
  // The resource exists, so the leftover file is an audit finding, not a
  // deletion candidate.
  const stale = classify({
    previousSection: {
      "riley-dupe": { uuid: "uuid-riley" },
      riley: { uuid: "uuid-riley" },
    },
    newSection: { riley: { uuid: "uuid-riley" } },
    liveUuids: new Set(["uuid-riley"]),
    resolveFiles: () => ["/repo/resources/org/assistants/riley-dupe.md"],
  });

  assert.deepEqual(stale, []);
});

test("classify: .vapi-ignore match is reported, never marked prunable", () => {
  const stale = classify({
    previousSection: { riley: { uuid: "uuid-riley" } },
    resolveFiles: () => ["/repo/resources/org/assistants/riley.md"],
    ignoreMatcher: () => "assistants/riley",
  });

  assert.equal(stale[0]?.disposition, "ignored");
  assert.equal(stale[0]?.ignorePattern, "assistants/riley");
});

test("classify: state entry with no local file is `no-file`", () => {
  const stale = classify({
    previousSection: { riley: { uuid: "uuid-riley" } },
  });

  assert.equal(stale[0]?.disposition, "no-file");
  assert.deepEqual(stale[0]?.filePaths, []);
});

test("classify: duplicate-extension twins are `ambiguous`", () => {
  const stale = classify({
    previousSection: { riley: { uuid: "uuid-riley" } },
    resolveFiles: () => [
      "/repo/resources/org/assistants/riley.yml",
      "/repo/resources/org/assistants/riley.yaml",
    ],
  });

  assert.equal(stale[0]?.disposition, "ambiguous");
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution — fact (4): only an explicit 404 authorizes deletion.
// ─────────────────────────────────────────────────────────────────────────────

function candidate(
  filePaths: string[],
  disposition: StaleTrackedResource["disposition"] = "prunable",
): StaleTrackedResource {
  return {
    resourceType: "assistants",
    resourceId: "riley",
    uuid: "uuid-riley",
    disposition,
    filePaths,
    ...(disposition === "ignored" ? { ignorePattern: "assistants/riley" } : {}),
  };
}

async function withTempFiles(
  names: string[],
  fn: (paths: string[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "vapi-prune-unit-"));
  try {
    const paths = names.map((name) => {
      const path = join(dir, name);
      writeFileSync(path, "local content\n");
      return path;
    });
    await fn(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("prune: a 404 on the UUID deletes the file", async () => {
  await withTempFiles(["riley.md"], async (paths) => {
    const result = await pruneStaleTrackedResources({
      stale: [candidate(paths)],
      fetchById: async () => null, // fetchResourceById maps 404 → null
      log: () => {},
    });

    assert.equal(result.deleted.length, 1);
    assert.equal(existsSync(paths[0] as string), false);
  });
});

test("prune: a resource the GET still returns is retained", async () => {
  await withTempFiles(["riley.md"], async (paths) => {
    const result = await pruneStaleTrackedResources({
      stale: [candidate(paths)],
      fetchById: async () => ({ id: "uuid-riley" }),
      log: () => {},
    });

    assert.deepEqual(result.deleted, []);
    assert.equal(result.retained[0]?.reason, "still-exists");
    assert.ok(existsSync(paths[0] as string));
  });
});

test("prune: a failed confirmation GET retains the file", async () => {
  // A 5xx, a timeout, or a dropped connection must never read as "deleted".
  await withTempFiles(["riley.md"], async (paths) => {
    const result = await pruneStaleTrackedResources({
      stale: [candidate(paths)],
      fetchById: async () => {
        throw new Error("API GET /assistant/uuid-riley failed (502): bad gateway");
      },
      log: () => {},
    });

    assert.deepEqual(result.deleted, []);
    assert.equal(result.retained[0]?.reason, "unconfirmed");
    assert.ok(existsSync(paths[0] as string));
  });
});

test("prune: an ignored candidate is retained without any platform call", async () => {
  await withTempFiles(["riley.md"], async (paths) => {
    let calls = 0;
    const result = await pruneStaleTrackedResources({
      stale: [candidate(paths, "ignored")],
      fetchById: async () => {
        calls++;
        return null;
      },
      log: () => {},
    });

    assert.equal(calls, 0, "no GET should be spent on a file we cannot delete");
    assert.equal(result.retained[0]?.reason, "ignored");
    assert.ok(existsSync(paths[0] as string));
  });
});

test("prune: ambiguous twins are retained even on a confirmed 404", async () => {
  await withTempFiles(["riley.yml", "riley.yaml"], async (paths) => {
    const result = await pruneStaleTrackedResources({
      stale: [candidate(paths, "ambiguous")],
      fetchById: async () => null,
      log: () => {},
    });

    assert.deepEqual(result.deleted, []);
    assert.equal(result.retained[0]?.reason, "ambiguous");
    for (const path of paths) assert.ok(existsSync(path));
  });
});

test("prune: an invalid prunable inventory is retained without a platform call", async () => {
  let calls = 0;
  const result = await pruneStaleTrackedResources({
    stale: [candidate([], "prunable")],
    fetchById: async () => {
      calls++;
      return null;
    },
    log: () => {},
  });

  assert.equal(calls, 0);
  assert.equal(result.retained[0]?.reason, "invalid-file-inventory");
});

// ─────────────────────────────────────────────────────────────────────────────
// Plain-pull reporting
// ─────────────────────────────────────────────────────────────────────────────

test("warn: counts only candidates that actually left a file behind", () => {
  const lines: string[] = [];
  const retained = warnStaleTrackedResources({
    stale: [
      candidate(["/repo/riley.md"]),
      candidate([], "no-file"),
      candidate(["/repo/ignored.md"], "ignored"),
    ],
    log: (message) => lines.push(message),
  });

  assert.equal(retained, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0] as string, /no longer in the dashboard listing/);
});
