import "./engine-sandbox.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import {
  credentialKindOf,
  credentialKindsLabel,
  credentialKindsRead,
  credentialKindsWrite,
} from "../src/credential-kinds.ts";
import { migrateAll } from "../src/migrate-hash-store.ts";
import { orgPolicyParse, orgPolicyRead } from "../src/org-policy.ts";
import { commitStepAcknowledge } from "../src/state-paths.ts";
import { stateFixturePath } from "./state-fixture.ts";

test("a credential's kind is its provider, and whether a bucket is set", () => {
  assert.deepEqual(credentialKindOf({ provider: "11labs", apiKey: "…" }), {
    provider: "11labs",
  });
  assert.deepEqual(
    credentialKindOf({ provider: "gcp", bucketPlan: { name: "calls" } }),
    { provider: "gcp", bucket: true },
  );
  assert.deepEqual(
    credentialKindOf({
      provider: "azure",
      bucketPlan: { containerName: "calls" },
    }),
    { provider: "azure", bucket: true },
  );
  // A speech key: same provider, no bucket.
  assert.deepEqual(credentialKindOf({ provider: "azure", bucketPlan: {} }), {
    provider: "azure",
  });
  assert.equal(credentialKindOf({}), undefined);
});

test("the kinds file round-trips, holds nothing else, and isn't rewritten unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-kinds-"));
  try {
    writeFileSync(stateFixturePath(dir, "clinic"), "{}\n");
    assert.equal(credentialKindsRead(dir, "clinic"), undefined);
    const kinds = {
      recordings: { provider: "azure", bucket: true as const },
      elevenlabs: { provider: "11labs" },
    };
    assert.equal(credentialKindsWrite(dir, "clinic", kinds), true);
    const file = join(dir, "state/clinic/credential-providers.json");
    assert.equal(
      readFileSync(file, "utf-8"),
      `{
  "elevenlabs": {
    "provider": "11labs"
  },
  "recordings": {
    "bucket": true,
    "provider": "azure"
  }
}
`,
    );
    assert.deepEqual(credentialKindsRead(dir, "clinic"), kinds);
    const written = statSync(file).mtimeMs;
    assert.equal(credentialKindsWrite(dir, "clinic", kinds), false);
    assert.equal(statSync(file).mtimeMs, written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("while an org's state is in the older layout the kinds file sits where that layout's commit step stages it, and migrate moves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-kinds-"));
  try {
    writeFileSync(join(dir, ".vapi-state.clinic.json"), "{}\n");
    const kinds = { elevenlabs: { provider: "11labs" } };
    assert.equal(credentialKindsWrite(dir, "clinic", kinds), true);
    const beside = join(
      dir,
      "resources/clinic/.vapi-credential-providers.json",
    );
    const inFolder = join(dir, "state/clinic/credential-providers.json");
    assert.equal(credentialKindsLabel(dir, "clinic"), relative(dir, beside));
    assert.equal(existsSync(beside), true);
    // Nothing of this org's is under state/, which that step doesn't stage.
    assert.equal(existsSync(join(dir, "state")), false);
    assert.deepEqual(credentialKindsRead(dir, "clinic"), kinds);

    commitStepAcknowledge(dir);
    await migrateAll(dir);
    assert.equal(existsSync(beside), false);
    assert.equal(credentialKindsLabel(dir, "clinic"), relative(dir, inFolder));
    assert.deepEqual(credentialKindsRead(dir, "clinic"), kinds);
    // And the next write goes to the folder.
    assert.equal(
      credentialKindsWrite(dir, "clinic", {
        deepgram: { provider: "deepgram" },
      }),
      true,
    );
    assert.equal(existsSync(beside), false);
    assert.match(readFileSync(inFolder, "utf-8"), /deepgram/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an org is customer-keys-only only when its policy file says so", () => {
  assert.deepEqual(orgPolicyParse(""), { customerKeysOnly: false });
  assert.deepEqual(orgPolicyParse("customerKeysOnly: true\n"), {
    customerKeysOnly: true,
  });
  assert.deepEqual(orgPolicyParse("# nothing set\n"), {
    customerKeysOnly: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "vapi-policy-"));
  try {
    assert.deepEqual(orgPolicyRead(dir), { customerKeysOnly: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a policy file that could be a typo is refused, not ignored", () => {
  assert.throws(
    () => orgPolicyParse("customerKeyOnly: true\n"),
    /unknown key "customerKeyOnly" \(known: customerKeysOnly\)/,
  );
  assert.throws(
    () => orgPolicyParse('customerKeysOnly: "yes"\n'),
    /customerKeysOnly must be true or false/,
  );
  assert.throws(
    () => orgPolicyParse("- customerKeysOnly\n"),
    /must be a mapping/,
  );
});
