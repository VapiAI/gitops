import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  _resetRunSnapshotDir,
  listSnapshotTimestamps,
  loadSnapshot,
  snapshotsRoot,
  writeSnapshot,
} from "../src/snapshot.ts";

// Stack H — snapshot writer / reader unit tests.
// `rollback-cmd.ts` itself is a thin CLI shell over PATCH; covered manually.

test("writeSnapshot writes outgoing+platform pair to per-run directory", async () => {
  _resetRunSnapshotDir();
  const tempDir = mkdtempSync(join(tmpdir(), "vapi-snapshot-"));
  try {
    const filePath = await writeSnapshot({
      baseDir: tempDir,
      env: "test-env",
      resourceType: "assistants",
      resourceId: "agent-a",
      payload: {
        outgoing: { name: "agent-a", version: 2 },
        platform: { name: "agent-a", version: 1 },
      },
    });
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    assert.equal(content.outgoing.version, 2);
    assert.equal(content.platform.version, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    _resetRunSnapshotDir();
  }
});

test("writeSnapshot stamps under snapshotsRoot/<timestamp>/<type>/<id>.json", async () => {
  _resetRunSnapshotDir();
  const tempDir = mkdtempSync(join(tmpdir(), "vapi-snapshot-"));
  try {
    const filePath = await writeSnapshot({
      baseDir: tempDir,
      env: "test-env",
      resourceType: "tools",
      resourceId: "end-call",
      payload: { outgoing: {}, platform: {} },
    });
    assert.ok(
      filePath.startsWith(snapshotsRoot(tempDir, "test-env")),
      `expected ${filePath} to live under ${snapshotsRoot(tempDir, "test-env")}`,
    );
    assert.ok(filePath.endsWith("/tools/end-call.json"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    _resetRunSnapshotDir();
  }
});

test("writeSnapshot escapes nested resourceIds (e.g. support/intake)", async () => {
  _resetRunSnapshotDir();
  const tempDir = mkdtempSync(join(tmpdir(), "vapi-snapshot-"));
  try {
    const filePath = await writeSnapshot({
      baseDir: tempDir,
      env: "test-env",
      resourceType: "assistants",
      resourceId: "support/intake",
      payload: { outgoing: {}, platform: {} },
    });
    // Nested IDs use `__` as path separator escape so the snapshot file
    // doesn't create accidental subdirs that confuse the loader.
    assert.ok(filePath.endsWith("support__intake.json"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    _resetRunSnapshotDir();
  }
});

test("loadSnapshot round-trips written entries", async () => {
  _resetRunSnapshotDir();
  const tempDir = mkdtempSync(join(tmpdir(), "vapi-snapshot-"));
  try {
    await writeSnapshot({
      baseDir: tempDir,
      env: "test-env",
      resourceType: "assistants",
      resourceId: "agent-a",
      payload: {
        outgoing: { name: "Agent A", n: 2 },
        platform: { name: "Agent A", n: 1 },
      },
    });
    await writeSnapshot({
      baseDir: tempDir,
      env: "test-env",
      resourceType: "tools",
      resourceId: "end-call",
      payload: { outgoing: {}, platform: { fn: "x" } },
    });

    const stamps = await listSnapshotTimestamps(tempDir, "test-env");
    assert.equal(stamps.length, 1);
    const entries = await loadSnapshot(tempDir, "test-env", stamps[0]!);
    assert.equal(entries.length, 2);

    const agent = entries.find((e) => e.resourceId === "agent-a");
    assert.ok(agent);
    assert.equal((agent!.payload.platform as { n: number }).n, 1);

    const tool = entries.find((e) => e.resourceId === "end-call");
    assert.ok(tool);
    assert.equal((tool!.payload.platform as { fn: string }).fn, "x");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
    _resetRunSnapshotDir();
  }
});

test("listSnapshotTimestamps returns empty array when no snapshots", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vapi-snapshot-"));
  try {
    const stamps = await listSnapshotTimestamps(tempDir, "test-env");
    assert.deepEqual(stamps, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadSnapshot throws when timestamp directory is missing", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vapi-snapshot-"));
  try {
    await assert.rejects(
      loadSnapshot(tempDir, "test-env", "missing-timestamp"),
      /Snapshot not found/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
