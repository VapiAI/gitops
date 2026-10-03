import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// The PR check workflow decides whether a pull request gets this
// repository's Vapi keys. Forks and Dependabot must never get them. These
// tests run the workflow's real steps (read from vapi-checks.yml, run with
// bash) so an edit that weakens the decision fails CI.

const REPO = fileURLToPath(new URL("..", import.meta.url));
const OWN_REPO = "acme/gitops";

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { "vapi-checks": { steps: Step[] } };
}

const WORKFLOW = parseYaml(
  readFileSync(join(REPO, ".github/workflows/vapi-checks.yml"), "utf8"),
) as Workflow;
const STEPS = WORKFLOW.jobs["vapi-checks"].steps;
const step = (name: string) => STEPS.find((s) => s.name === name)!;

interface PullRequest {
  event: string;
  headRepo?: string;
  actor?: string;
  author?: string;
}

// Run the "Choose live or dry run" step and return its `live` output.
function liveDecision(pr: PullRequest): string {
  const dir = mkdtempSync(join(tmpdir(), "vapi-checks-mode-"));
  try {
    const output = join(dir, "output");
    writeFileSync(output, "");
    const result = spawnSync(
      "bash",
      ["-e", "-c", step("Choose live or dry run").run!],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: OWN_REPO,
          EVENT: pr.event,
          HEAD_REPO: pr.headRepo ?? "",
          ACTOR: pr.actor ?? "",
          AUTHOR: pr.author ?? "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(output, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("only same-repository, non-Dependabot pull requests and manual runs go live", () => {
  const cases: Array<[string, PullRequest, string]> = [
    [
      "own branch",
      {
        event: "pull_request",
        headRepo: OWN_REPO,
        actor: "dev",
        author: "dev",
      },
      "live=true",
    ],
    [
      "manual dispatch",
      { event: "workflow_dispatch", actor: "maintainer" },
      "live=true",
    ],
    [
      "fork",
      {
        event: "pull_request",
        headRepo: "someone/gitops",
        actor: "someone",
        author: "someone",
      },
      "live=false",
    ],
    [
      "fork with a look-alike name",
      {
        event: "pull_request",
        headRepo: "acme/gitops-fork",
        actor: "x",
        author: "x",
      },
      "live=false",
    ],
    [
      "Dependabot",
      {
        event: "pull_request",
        headRepo: OWN_REPO,
        actor: "dependabot[bot]",
        author: "dependabot[bot]",
      },
      "live=false",
    ],
    [
      "a maintainer re-running Dependabot's PR",
      {
        event: "pull_request",
        headRepo: OWN_REPO,
        actor: "maintainer",
        author: "dependabot[bot]",
      },
      "live=false",
    ],
    [
      "Dependabot pushing to a maintainer's PR",
      {
        event: "pull_request",
        headRepo: OWN_REPO,
        actor: "dependabot[bot]",
        author: "dev",
      },
      "live=false",
    ],
    [
      "missing head repository",
      { event: "pull_request", actor: "dev", author: "dev" },
      "live=false",
    ],
    [
      "any other event",
      {
        event: "pull_request_target",
        headRepo: OWN_REPO,
        actor: "dev",
        author: "dev",
      },
      "live=false",
    ],
  ];
  assert.deepEqual(
    cases.map(([label, pr]) => [label, liveDecision(pr)]),
    cases.map(([label, , expected]) => [label, expected]),
  );
});

interface RunArgs {
  live: boolean;
  check?: string;
  event?: string;
  baseRefExists?: boolean;
  checkTokens?: string;
  privateKey?: string;
}

// Run the "Run Vapi checks" step with a stub `node` that records its
// arguments and which key variables it received.
function runStep(args: RunArgs): {
  argv: string[];
  tokens: string;
  key: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "vapi-checks-run-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const record = join(dir, "record");
    writeFileSync(
      join(bin, "node"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${record}"\necho "TOKENS=\${VAPI_CHECK_TOKENS-unset}" >> "${record}.env"\necho "KEY=\${VAPI_PRIVATE_API_KEY-unset}" >> "${record}.env"\n`,
    );
    chmodSync(join(bin, "node"), 0o755);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a],
        { cwd: repo, stdio: "pipe" },
      );
    git("init", "-q", "-b", "feature");
    git("commit", "-q", "--allow-empty", "-m", "base");
    if (args.baseRefExists ?? true)
      git("update-ref", "refs/remotes/origin/main", "HEAD");
    const result = spawnSync(
      "bash",
      ["-e", "-c", step("Run Vapi checks").run!],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          LIVE: String(args.live),
          CHECK: args.check ?? "",
          GITHUB_EVENT_NAME: args.event ?? "pull_request",
          BASE_REF: "main",
          VAPI_CHECK_TOKENS: args.checkTokens ?? "",
          VAPI_PRIVATE_API_KEY: args.privateKey ?? "",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const env = readFileSync(`${record}.env`, "utf8");
    return {
      argv: readFileSync(record, "utf8").trim().split("\n"),
      tokens: env.match(/TOKENS=(.*)/)![1]!,
      key: env.match(/KEY=(.*)/)![1]!,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a dry run builds payloads only; a live run refreshes bindings; PRs select changed checks", () => {
  const dry = runStep({ live: false });
  const live = runStep({ live: true, checkTokens: '{"acme":"k"}' });
  const named = runStep({
    live: true,
    check: "core",
    event: "workflow_dispatch",
    privateKey: "k",
  });
  const noBase = runStep({ live: false, baseRefExists: false });
  const tail = ["--budget-minutes", "22"];
  assert.deepEqual(
    { dry: dry.argv, live: live.argv, named: named.argv, noBase: noBase.argv },
    {
      dry: [
        "--import",
        "tsx",
        "src/check-cmd.ts",
        "--all",
        "--dry-run",
        "--changed-since",
        "origin/main",
        ...tail,
      ],
      live: [
        "--import",
        "tsx",
        "src/check-cmd.ts",
        "--all",
        "--refresh-bindings",
        "--changed-since",
        "origin/main",
        ...tail,
      ],
      named: [
        "--import",
        "tsx",
        "src/check-cmd.ts",
        "core",
        "--refresh-bindings",
        ...tail,
      ],
      noBase: [
        "--import",
        "tsx",
        "src/check-cmd.ts",
        "--all",
        "--dry-run",
        ...tail,
      ],
    },
  );
});

test("empty key variables are unset rather than passed as empty strings", () => {
  const dry = runStep({ live: false });
  const live = runStep({ live: true, checkTokens: '{"acme":"k"}' });
  assert.deepEqual(
    [dry.tokens, dry.key, live.tokens, live.key],
    ["unset", "unset", '{"acme":"k"}', "unset"],
  );
});

test("secrets reach the run step only for live runs, and the workflow never runs fork code with secrets", () => {
  const env = step("Run Vapi checks").env!;
  const checkout = STEPS.find((s) => s.uses?.startsWith("actions/checkout"))!;
  assert.deepEqual(
    {
      checkTokens: env.VAPI_CHECK_TOKENS,
      privateKey: env.VAPI_PRIVATE_API_KEY,
      triggers: Object.keys(WORKFLOW.on).sort(),
      permissions: WORKFLOW.permissions,
      persistCredentials: checkout.with?.["persist-credentials"],
    },
    {
      checkTokens:
        "${{ steps.mode.outputs.live == 'true' && secrets.VAPI_CHECK_TOKENS || '' }}",
      privateKey:
        "${{ steps.mode.outputs.live == 'true' && secrets.VAPI_PRIVATE_API_KEY || '' }}",
      triggers: ["pull_request", "workflow_dispatch"],
      permissions: { contents: "read", statuses: "write" },
      persistCredentials: false,
    },
  );
});
