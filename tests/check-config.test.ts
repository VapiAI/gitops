import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHECK_DEFAULTS,
  checksConfigLoad,
  checksConfigParse,
} from "../src/check-config.ts";

const EXAMPLE = fileURLToPath(
  new URL("../vapi-checks.example.yml", import.meta.url),
);

function errorOf(content: string): string {
  try {
    checksConfigParse(content);
    return "no error";
  } catch (error) {
    return (error as Error).message;
  }
}

const MINIMAL = `version: 1
checks:
  core:
    org: acme
    targets: [squads/main-squad]
    suites: [core]
`;

test("a minimal check gets the defaults, runs in its own org, and binds credentials", () => {
  assert.deepEqual(checksConfigParse(MINIMAL), {
    version: 1,
    checks: {
      core: {
        name: "core",
        org: "acme",
        runOrg: "acme",
        baseUrl: undefined,
        targets: [{ type: "squads", id: "main-squad" }],
        suites: ["core"],
        simulations: [],
        bindings: {
          credentials: { default: "bind", aliases: {} },
          phoneNumbers: { default: "omit", aliases: {} },
        },
        paths: [],
        ...CHECK_DEFAULTS,
      },
    },
  });
});

test("check settings override defaults, which override the built-in defaults", () => {
  const config = checksConfigParse(`version: 1
defaults:
  transport: voice
  iterations: 3
checks:
  a:
    org: acme
    targets: [assistants/team/intake]
    simulations: [books-calm]
    iterations: 2
    toolMocks: off
    stripWebhooks: false
    timeoutMinutes: 7.5
  b:
    org: acme
    runOrg: acme-ci
    baseUrl: https://api.eu.vapi.ai/
    targets: [assistants/intake, squads/main]
    suites: [core]
    bindings: { credentials: { default: omit, crm: bind } }
    paths: ["prompts/**"]
`);
  const { a, b } = config.checks;
  assert.deepEqual(
    {
      a: [
        a!.transport,
        a!.iterations,
        a!.toolMocks,
        a!.stripWebhooks,
        a!.timeoutMinutes,
        a!.targets,
      ],
      b: [
        b!.transport,
        b!.iterations,
        b!.runOrg,
        b!.baseUrl,
        b!.targets.length,
        b!.bindings.credentials,
        b!.paths,
      ],
    },
    {
      a: [
        "voice",
        2,
        "off",
        false,
        7.5,
        [{ type: "assistants", id: "team/intake" }],
      ],
      b: [
        "voice",
        3,
        "acme-ci",
        "https://api.eu.vapi.ai",
        2,
        { default: "omit", aliases: { crm: "bind" } },
        ["prompts/**"],
      ],
    },
  );
});

test("every invalid shape is rejected with a message naming the field", () => {
  const check = (body: string) =>
    `version: 1\nchecks:\n  core:\n    org: acme\n${body}`;
  const withTargets = (body: string) =>
    check(`    targets: [squads/main]\n${body}`);
  const cases: Array<[string, string]> = [
    ["", "vapi-checks.yml must be a mapping"],
    ["version: 2\nchecks: {}\n", "vapi-checks.yml version must be 1"],
    [
      "version: 1\nchecks: {}\n",
      "vapi-checks.yml must declare at least one check",
    ],
    ["version: 1\nchecks: []\n", "checks must be a mapping"],
    [
      "version: 1\npipelines: {}\nchecks: {}\n",
      'vapi-checks.yml has unknown key "pipelines" (allowed: version, defaults, checks)',
    ],
    [
      "version: 1\ndefaults:\n  org: acme\nchecks: {}\n",
      'defaults has unknown key "org" (allowed: transport, iterations, timeoutMinutes, toolMocks, stripWebhooks)',
    ],
    [
      "version: 1\nchecks:\n  Core:\n    org: acme\n",
      'check name "Core" must be a lowercase slug (a-z, 0-9, -)',
    ],
    [
      withTargets("    suites: [core]\n    mode: deployed\n"),
      "checks.core.mode is not supported: checks always build the target from the branch's files",
    ],
    [
      withTargets("    suites: [core]\n    suite: core\n"),
      'checks.core has unknown key "suite" (allowed: org, runOrg, baseUrl, targets, suites, simulations, bindings, paths, transport, iterations, timeoutMinutes, toolMocks, stripWebhooks)',
    ],
    [
      "version: 1\nchecks:\n  core:\n    targets: [squads/main]\n    suites: [core]\n",
      "checks.core.org must be a lowercase slug (a-z, 0-9, -)",
    ],
    [
      withTargets("    suites: [core]\n    runOrg: Acme_CI\n"),
      "checks.core.runOrg must be a lowercase slug (a-z, 0-9, -)",
    ],
    [
      check("    suites: [core]\n"),
      "checks.core.targets must list at least one target",
    ],
    [
      check("    targets: squads/main\n    suites: [core]\n"),
      "checks.core.targets must be a list",
    ],
    [
      check("    targets: [tools/lookup]\n    suites: [core]\n"),
      'checks.core.targets[0] must be "assistants/<id>" or "squads/<id>", got "tools/lookup"',
    ],
    [
      check("    targets: [main-squad]\n    suites: [core]\n"),
      'checks.core.targets[0] must be "assistants/<id>" or "squads/<id>", got "main-squad"',
    ],
    [
      check("    targets: [squads/main.yml]\n    suites: [core]\n"),
      "checks.core.targets[0] must not include a file extension: main.yml",
    ],
    [
      check("    targets: [squads/../other]\n    suites: [core]\n"),
      "checks.core.targets[0] must be a relative resource ID: ../other",
    ],
    [
      check("    targets: [squads/main, squads/main]\n    suites: [core]\n"),
      "checks.core.targets lists squads/main twice",
    ],
    [withTargets(""), "checks.core must list at least one suite or simulation"],
    [
      withTargets("    suites: []\n    simulations: []\n"),
      "checks.core must list at least one suite or simulation",
    ],
    [
      withTargets("    suites: [core, core]\n"),
      "checks.core.suites lists core twice",
    ],
    [
      withTargets("    suites: [1]\n"),
      "checks.core.suites[0] must be a non-empty resource ID",
    ],
    [
      withTargets("    suites: [core]\n    transport: phone\n"),
      'checks.core.transport must be "chat" or "voice"',
    ],
    [
      withTargets("    suites: [core]\n    iterations: 11\n"),
      "checks.core.iterations must be an integer from 1 to 10",
    ],
    [
      withTargets("    suites: [core]\n    iterations: 1.5\n"),
      "checks.core.iterations must be an integer from 1 to 10",
    ],
    [
      withTargets("    suites: [core]\n    timeoutMinutes: 0\n"),
      "checks.core.timeoutMinutes must be a number above 0 and at most 120",
    ],
    [
      withTargets("    suites: [core]\n    toolMocks: loose\n"),
      'checks.core.toolMocks must be "strict" or "off"',
    ],
    [
      withTargets("    suites: [core]\n    stripWebhooks: 'no'\n"),
      "checks.core.stripWebhooks must be true or false",
    ],
    [
      withTargets("    suites: [core]\n    baseUrl: api.vapi.ai\n"),
      "checks.core.baseUrl must be an http(s) URL",
    ],
    [
      withTargets("    suites: [core]\n    paths: ['']\n"),
      "checks.core.paths[0] must be a non-empty glob",
    ],
    [
      withTargets(
        "    suites: [core]\n    bindings: { credentials: { default: maybe } }\n",
      ),
      'bindings.credentials.default must be "bind" or "omit"',
    ],
  ];
  assert.deepEqual(
    cases.map(([content]) => errorOf(content)),
    cases.map(([, message]) => message),
  );
});

test("the shipped example parses", () => {
  const config = checksConfigParse(readFileSync(EXAMPLE, "utf8"));
  assert.deepEqual(Object.keys(config.checks), ["core"]);
});

test("the example's commented CI-org check parses once uncommented", () => {
  const example = readFileSync(EXAMPLE, "utf8");
  const start = example.indexOf("  # staging-core:");
  const uncommented =
    example.slice(0, start) + example.slice(start).replace(/^  # /gm, "  ");
  const config = checksConfigParse(uncommented);
  assert.deepEqual(
    [
      config.checks["staging-core"]!.runOrg,
      config.checks["staging-core"]!.toolMocks,
    ],
    ["example-ci", "off"],
  );
});

test("checksConfigLoad returns null without a vapi-checks.yml and parses one when present", () => {
  const root = mkdtempSync(join(tmpdir(), "check-config-"));
  try {
    const missing = checksConfigLoad(root);
    writeFileSync(join(root, "vapi-checks.yml"), MINIMAL);
    assert.deepEqual(
      [missing, Object.keys(checksConfigLoad(root)!.checks)],
      [null, ["core"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
