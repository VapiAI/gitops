import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

test("existing example-style env files preserve API keys and base URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "vapi-env-compat-"));
  try {
    cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(REPO, "package.json"), join(dir, "package.json"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    const env = { ...process.env };
    for (const name of [
      "VAPI_PRIVATE_API_KEY",
      "VAPI_PRIVATE_API_KEY_ACME_PROD",
      "VAPI_TOKEN",
      "VAPI_BASE_URL",
      "VAPI_MAX_GITOPS_RPM",
    ])
      delete env[name];
    const example = readFileSync(join(REPO, ".env.example"), "utf8");
    for (const quote of ["", "'", '"']) {
      writeFileSync(
        join(dir, ".env.acme-prod"),
        example
          .replace(
            "your-vapi-private-key-here",
            `${quote}fixture-private-key${quote}`,
          )
          .replace(
            "# VAPI_BASE_URL=https://api.eu.vapi.ai",
            `VAPI_BASE_URL=${quote}https://api.eu.vapi.ai${quote}`,
          ),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          'process.argv = ["node", "config-test", "acme-prod"]; const config = await import("./src/config.ts"); const assert = await import("node:assert/strict"); assert.equal(config.VAPI_TOKEN, "fixture-private-key"); assert.equal(config.VAPI_BASE_URL, "https://api.eu.vapi.ai"); console.log("config values match");',
        ],
        { cwd: dir, encoding: "utf8", env, timeout: 30000 },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /config values match/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
