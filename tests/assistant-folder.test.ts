import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  withAssistantFolder,
  withoutAssistantFolder,
} from "../src/assistant-folder.ts";
import { canonicalizeForHash } from "../src/canonical.ts";
import { hashPayload } from "../src/state-serialize.ts";
import type { StateFile } from "../src/types.ts";

const state = {
  assistants: {},
  tools: {},
  squads: {},
  structuredOutputs: {},
  personalities: {},
  scenarios: {},
  simulations: {},
  simulationSuites: {},
  evals: {},
  credentials: {},
} as StateFile;

test("assistant POST/PATCH and response baselines share the folder-free hash basis", () => {
  const root = new URL("../", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "gitops-folder-"));
  try {
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(dir, "package.json"));
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    const script = `
      import assert from 'node:assert/strict';
      process.argv = ['node', 'test', 'folder-test'];
      process.env.VAPI_TOKEN = 'fake';
      process.env.VAPI_GITOPS_ORG_PIN = 'off';
      const { applyAssistant } = await import('./src/push.ts');
      const { readBaseline } = await import('./src/hash-store.ts');
      const { hashPayload } = await import('./src/state-serialize.ts');
      const state = ${JSON.stringify(state)};
      const requests = [];
      globalThis.fetch = async (url, options) => {
        if (options.method === 'GET') return new Response(JSON.stringify({ ...data, id: 'uuid', orgId: 'org', metadata: { team: 'support', folderPath: 'old' } }));
        const body = JSON.parse(options.body);
        requests.push({ method: options.method, body });
        return new Response(JSON.stringify({ ...body, id: 'uuid', orgId: 'org' }));
      };
      const data = { name: 'Intake', metadata: { team: 'support' } };
      await applyAssistant({ resourceId: 'support/tier2/intake', filePath: '', data }, state);
      assert.equal(requests[0].method, 'POST');
      assert.deepEqual(requests[0].body.metadata, { team: 'support', folderPath: 'support/tier2' });
      assert.equal(readBaseline('folder-test', 'uuid'), hashPayload(data));
      requests.length = 0;
      state.assistants.intake = { uuid: 'uuid' };
      await applyAssistant({ resourceId: 'intake', filePath: '', data }, state);
      const patch = requests.find(r => r.method === 'PATCH' && r.body.name === 'Intake');
      assert.deepEqual(patch.body.metadata, { team: 'support', folderPath: null });
      assert.equal(readBaseline('folder-test', 'uuid'), hashPayload(data));
      const { pullResourceType } = await import('./src/pull.ts');
      const { hashLocalResource } = await import('./src/resources.ts');
      const { readFileSync, mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync('./resources/folder-test/assistants', { recursive: true });
      writeFileSync('./resources/folder-test/assistants/intake.md', '---\\nname: Intake\\nmetadata:\\n  team: support\\n---\\n');
      globalThis.fetch = async () => new Response(JSON.stringify([
        { ...data, id: 'uuid', orgId: 'org', metadata: { team: 'support', folderPath: 'support' } },
      ]));
      const pulled = await pullResourceType('assistants', state, { force: true });
      assert.equal(pulled.created + pulled.updated, 1);
      const yaml = readFileSync('./resources/folder-test/assistants/intake.md', 'utf8');
      assert.ok(!yaml.includes('folderPath'));
      assert.ok(yaml.includes('team: support'));
      assert.equal(hashLocalResource('assistants', 'intake'), readBaseline('folder-test', 'uuid'));
    `;
    const result = spawnSync(
      "node",
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: dir,
        env: { ...process.env, VAPI_BASE_URL: "http://127.0.0.1:9" },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folder payloads preserve user metadata and override derived values", () => {
  const data = {
    name: "Intake",
    metadata: { team: "support", folderPath: "old" },
  };
  assert.deepEqual(withAssistantFolder(data, "support/tier2/intake"), {
    name: "Intake",
    metadata: { team: "support", folderPath: "support/tier2" },
  });
  assert.equal(data.metadata.folderPath, "old");
  assert.deepEqual(withAssistantFolder({}, "support/intake"), {
    metadata: { folderPath: "support" },
  });
});

test("moving to root explicitly clears a stale folder without losing metadata", () => {
  assert.deepEqual(
    withAssistantFolder(
      { metadata: { team: "support", folderPath: "old" } },
      "intake",
    ),
    {
      metadata: { team: "support", folderPath: null },
    },
  );
  assert.deepEqual(withAssistantFolder({}, "intake"), {
    metadata: { folderPath: null },
  });
  assert.deepEqual(withAssistantFolder({ metadata: null }, "intake"), {
    metadata: { folderPath: null },
  });
});

test("invalid assistant metadata is rejected instead of silently overwritten", () => {
  for (const metadata of ["bad", 1, []]) {
    assert.throws(
      () => withAssistantFolder({ metadata }, "intake"),
      /metadata must be an object/,
    );
  }
});

test("pull and drift canonical forms ignore only assistant folder metadata", () => {
  for (const folderPath of ["support", "support/tier2", null]) {
    const remote = {
      id: "uuid",
      orgId: "org",
      name: "Intake",
      metadata: { team: "support", folderPath },
    };
    const local = { name: "Intake", metadata: { team: "support" } };
    const canonical = canonicalizeForHash(
      remote,
      state,
      new Map(),
      "assistants",
    );
    assert.deepEqual(canonical, local);
    assert.equal(
      hashPayload(canonical),
      hashPayload(withoutAssistantFolder(local)),
    );
    assert.deepEqual(
      canonicalizeForHash(remote, state, new Map(), "squads").metadata,
      remote.metadata,
    );
    assert.equal(remote.metadata.folderPath, folderPath);
  }
  assert.deepEqual(
    withoutAssistantFolder({ metadata: { folderPath: "support" } }),
    {},
  );
  assert.deepEqual(withoutAssistantFolder({ metadata: {} }), {});
  assert.deepEqual(withoutAssistantFolder({ name: "Intake" }), {
    name: "Intake",
  });
});
