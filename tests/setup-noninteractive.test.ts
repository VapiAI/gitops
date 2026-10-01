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
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isPlaceholderToken,
  parseSetupArgs,
  readEnvValue,
} from "../src/setup-args.ts";

// `npm run setup` used to be interactive-only. In a non-TTY shell (AI coding
// agents, CI) the prompt library died with "User force closed the prompt",
// leaving no documented way to bootstrap an org without a human at a
// keyboard. These tests pin the non-interactive path and its guard rails.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── Argument parsing ─────────────────────────────────────────────────────

test("setup args: no arguments selects the interactive wizard", () => {
  assert.deepEqual(parseSetupArgs([]), { mode: "interactive" });
});

test("setup args: org slug selects direct mode with defaults", () => {
  assert.deepEqual(parseSetupArgs(["my-org"]), {
    mode: "direct",
    options: { slug: "my-org", region: undefined, resources: "all" },
  });
});

test("setup args: --region and --resources accept spaced and = forms", () => {
  assert.deepEqual(
    parseSetupArgs(["my-org", "--region", "eu", "--resources=none"]),
    {
      mode: "direct",
      options: { slug: "my-org", region: "eu", resources: "none" },
    },
  );
});

test("setup args: rejects invalid values, unknown flags, and bad slugs", () => {
  for (const argv of [
    ["my-org", "--region", "apac"],
    ["my-org", "--resources", "some"],
    ["my-org", "--region"],
    ["my-org", "--yes"],
    ["My Org"],
    ["my-org", "other-org"],
    ["--region", "us"],
  ]) {
    const parsed = parseSetupArgs(argv);
    assert.equal(parsed.mode, "error", `expected error for ${argv.join(" ")}`);
  }
});

test("setup args: refuses API keys passed on the command line", () => {
  for (const argv of [
    ["my-org", "--token", "sk-123"],
    ["my-org", "--token=sk-123"],
    ["my-org", "--api-key", "sk-123"],
  ]) {
    const parsed = parseSetupArgs(argv);
    assert.equal(parsed.mode, "error");
    assert.match(
      (parsed as { message: string }).message,
      /Refusing to read an API key from the command line/,
    );
  }
});

test("setup args: --help wins over everything else", () => {
  assert.deepEqual(parseSetupArgs(["my-org", "--bogus", "-h"]), {
    mode: "help",
  });
});

test("readEnvValue handles quotes, export, comments, and missing keys", () => {
  const content = [
    "# comment VAPI_TOKEN=nope",
    "export VAPI_BASE_URL='https://api.eu.vapi.ai'",
    'VAPI_TOKEN="abc-123"',
    "OTHER=1",
  ].join("\n");
  assert.equal(readEnvValue(content, "VAPI_TOKEN"), "abc-123");
  assert.equal(readEnvValue(content, "VAPI_BASE_URL"), "https://api.eu.vapi.ai");
  assert.equal(readEnvValue(content, "MISSING"), undefined);
  assert.equal(readEnvValue("VAPI_TOKEN=\n", "VAPI_TOKEN"), undefined);
});

test("isPlaceholderToken recognizes the .env.example placeholder", () => {
  assert.equal(isPlaceholderToken("your-vapi-private-key-here"), true);
  assert.equal(isPlaceholderToken("3f9a1c2e-real-looking-key"), false);
});

// ── End-to-end failure paths (no network) ────────────────────────────────

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vapi-setup-test-"));
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runSetup(cwd: string, args: string[], env: Record<string, string> = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.VAPI_TOKEN;
  delete baseEnv.VAPI_PRIVATE_API_KEY;
  delete baseEnv.VAPI_BASE_URL;
  const result = spawnSync("node", ["--import", "tsx", "src/setup.ts", ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    // stdin is a pipe, not a TTY — exactly what an agent's shell looks like.
    input: "",
    encoding: "utf-8",
    timeout: 20_000,
  });
  return {
    code: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

test("setup without a TTY explains the non-interactive path instead of crashing", () => {
  const fx = sandbox();
  try {
    const res = runSetup(fx.dir, []);
    assert.equal(res.code, 1);
    assert.match(res.output, /needs an interactive terminal/);
    assert.match(res.output, /npm run setup -- <org>/);
    assert.doesNotMatch(res.output, /force closed/);
  } finally {
    fx.cleanup();
  }
});

test("direct setup without any API key fails with actionable guidance", () => {
  const fx = sandbox();
  try {
    const res = runSetup(fx.dir, ["my-org"]);
    assert.equal(res.code, 1);
    assert.match(res.output, /No Vapi private API key found/);
    assert.match(res.output, /\.env\.my-org/);
    assert.match(res.output, /dashboard\.vapi\.ai\/org\/api-keys/);
    assert.match(res.output, /VAPI_PRIVATE_API_KEY=/);
  } finally {
    fx.cleanup();
  }
});

test("direct setup treats the copied .env.example placeholder as no key", () => {
  const fx = sandbox();
  try {
    writeFileSync(
      join(fx.dir, ".env.my-org"),
      "VAPI_PRIVATE_API_KEY=your-vapi-private-key-here\n",
    );
    const res = runSetup(fx.dir, ["my-org"]);
    assert.equal(res.code, 1);
    assert.match(res.output, /No Vapi private API key found/);
  } finally {
    fx.cleanup();
  }
});

test("direct setup refuses to touch an org that already exists locally", () => {
  const fx = sandbox();
  try {
    mkdirSync(join(fx.dir, "resources", "my-org"), { recursive: true });
    const res = runSetup(fx.dir, ["my-org"], { VAPI_PRIVATE_API_KEY: "fake-not-used" });
    assert.equal(res.code, 1);
    assert.match(res.output, /already set up locally/);
    assert.match(res.output, /npm run pull -- my-org/);
    // Must fail before any network call.
    assert.doesNotMatch(res.output, /Validating against/);
  } finally {
    fx.cleanup();
  }
});
