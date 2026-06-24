import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertStateMigrated,
  migrateAll,
} from "../src/migrate-hash-store.ts";
import {
  serializeState,
  sortedKeysReplacer,
} from "../src/state-serialize.ts";
import type { StateFile } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// State-file integration for the `variables` section.
//
// The migration seam treats every top-level object as a `name → { uuid }`
// section. The `variables` section is the exception: it holds raw values, so
// it MUST be exempted from both the legacy-format guard (or it would block
// every push/pull) and the slimming rewrite (or `npm run migrate` would drop
// it). These specs pin that exemption.
// ─────────────────────────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vapi-state-vars-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("assertStateMigrated: a variables section does NOT trip the legacy guard", () => {
  withTempDir((dir) => {
    const statePath = join(dir, ".vapi-state.acme.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        tools: { "my-tool": { uuid: "11111111-1111-1111-1111-111111111111" } },
        variables: {
          callback_url: "https://example.com/vapi/webhook",
          max_tokens: 260,
          server: { url: "https://example.com/srv", timeoutSeconds: 20 },
        },
      }),
    );
    // Must NOT throw — variable values are raw (not `{ uuid }`), and would
    // otherwise look exactly like the legacy fat-state shape.
    assert.doesNotThrow(() => assertStateMigrated(statePath));
  });
});

test("assertStateMigrated: still throws on a genuinely legacy uuid-section entry", () => {
  withTempDir((dir) => {
    const statePath = join(dir, ".vapi-state.acme.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        tools: {
          "my-tool": {
            uuid: "11111111-1111-1111-1111-111111111111",
            lastPulledHash: "deadbeef", // legacy fat field
          },
        },
        variables: { callback_url: "https://example.com/hook" },
      }),
    );
    assert.throws(() => assertStateMigrated(statePath), /legacy format/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeState — variable VALUE key order is preserved; everything else is
// byte-identical to the prior sortedKeysReplacer serialization (review #2).
// ─────────────────────────────────────────────────────────────────────────────

function emptySections(): Omit<StateFile, "variables"> {
  return {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

test("serializeState: preserves hand-authored object-variable key order", () => {
  const state: StateFile = {
    ...emptySections(),
    variables: {
      // intentionally NOT alphabetical — must round-trip in this order
      server: { url: "https://example.com/srv", timeoutSeconds: 20, retries: 3 },
    },
  };
  const json = serializeState(state);
  const keysInOrder = json.match(/"url"|"timeoutSeconds"|"retries"/g);
  assert.deepEqual(keysInOrder, ['"url"', '"timeoutSeconds"', '"retries"']);
});

test("serializeState: sorts variable NAMES (anti-churn) but not value internals", () => {
  const state: StateFile = {
    ...emptySections(),
    variables: { zeta: 1, alpha: 2 },
  };
  const json = serializeState(state);
  assert.ok(json.indexOf('"alpha"') < json.indexOf('"zeta"'));
});

test("serializeState: byte-identical to sortedKeysReplacer for a variable-free state", () => {
  const state: StateFile = {
    ...emptySections(),
    tools: {
      "b-tool": { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
      "a-tool": { uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    },
    variables: {},
  };
  assert.equal(
    serializeState(state),
    JSON.stringify(state, sortedKeysReplacer, 2),
  );
});

test("migrateAll: preserves the variables section verbatim while slimming legacy entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-state-vars-"));
  try {
    const statePath = join(dir, ".vapi-state.testorg.json");
    // Bare-string tool entry forces a slim rewrite; it carries no hash, so
    // migrateAll writes nothing to the real hash store (no side effects).
    writeFileSync(
      statePath,
      JSON.stringify({
        tools: { foo: "22222222-2222-2222-2222-222222222222" },
        variables: {
          callback_url: "https://example.com/vapi/webhook",
          max_tokens: 260,
          server: { url: "https://example.com/srv" },
        },
      }),
    );

    await migrateAll(dir);

    const rewritten = JSON.parse(readFileSync(statePath, "utf-8"));
    // Legacy entry slimmed to `{ uuid }`.
    assert.deepEqual(rewritten.tools, {
      foo: { uuid: "22222222-2222-2222-2222-222222222222" },
    });
    // Variables survived untouched.
    assert.deepEqual(rewritten.variables, {
      callback_url: "https://example.com/vapi/webhook",
      max_tokens: 260,
      server: { url: "https://example.com/srv" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
