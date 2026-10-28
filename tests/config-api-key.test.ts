import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every org command binds its key in config.ts. An exported generic
// VAPI_PRIVATE_API_KEY used to replace .env.<org>'s key with only a
// "Loaded env file" line on screen, so a second org's commands silently ran
// with the first org's key. These run `validate` (offline) to see what a
// command reports about its key.

const REPO = fileURLToPath(new URL("..", import.meta.url));

function validateRun(
  envFile: string,
  env: Record<string, string>,
): { code: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "vapi-config-key-"));
  try {
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    mkdirSync(join(dir, "resources", "acme-prod"), { recursive: true });
    writeFileSync(join(dir, ".env.acme-prod"), envFile);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/validate-cmd.ts", "acme-prod"],
      { cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, ...env } },
    );
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a generic exported key overriding a different .env.<org> key warns on stderr", () => {
  const run = validateRun("VAPI_PRIVATE_API_KEY=prod-key\n", {
    VAPI_PRIVATE_API_KEY: "dev-key",
  });
  assert.match(run.stderr, /not the different key in \.env\.acme-prod/);
  assert.match(run.stderr, /VAPI_PRIVATE_API_KEY_ACME_PROD/);
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /prod-key|dev-key/);
});

test("the org's own variable is used and named, with no warning", () => {
  const run = validateRun("VAPI_PRIVATE_API_KEY=stale-key\n", {
    VAPI_PRIVATE_API_KEY: "dev-key",
    VAPI_PRIVATE_API_KEY_ACME_PROD: "prod-key",
  });
  assert.match(
    run.stdout,
    /Using the API key from the VAPI_PRIVATE_API_KEY_ACME_PROD environment variable/,
  );
  assert.doesNotMatch(run.stderr, /different key/);
});

test("a key only in .env.<org> is used quietly", () => {
  const run = validateRun("VAPI_PRIVATE_API_KEY=prod-key\n", {});
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /Using the API key|different key/);
  assert.equal(run.code, 0);
});
