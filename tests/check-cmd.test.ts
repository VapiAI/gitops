import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCommandRun } from "../src/check-cmd.ts";

const PARITY_ROOT = fileURLToPath(
  new URL("./fixtures/check-parity/", import.meta.url),
);

async function run(
  args: string[],
  root: string,
): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    return { code: await checkCommandRun(args, root), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function parityCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "check-cmd-"));
  cpSync(PARITY_ROOT, root, { recursive: true });
  return root;
}

test("a dry run of the parity fixture builds the payload and writes it with --print-payload", async () => {
  const root = parityCopy();
  try {
    const result = await run(["core", "--dry-run", "--print-payload"], root);
    const file = join(root, "tmp/check-payloads/core--squads--dental.json");
    const body = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(
      [
        result.code,
        result.out.includes("✅ 3 simulations × 1 iteration over chat"),
        body.simulations.length,
      ],
      [0, true, 3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--all runs every check; a build error exits 2 and names the problem", async () => {
  const root = parityCopy();
  try {
    writeFileSync(
      join(root, "vapi-checks.yml"),
      "version: 1\nchecks:\n  core:\n    org: parity\n    targets: [squads/dental]\n    suites: [core]\n  broken:\n    org: parity\n    targets: [assistants/receptionist]\n    suites: [core]\n",
    );
    const result = await run(["--all", "--dry-run"], root);
    assert.deepEqual(
      [
        result.code,
        result.out.includes("core / squads/dental\n  ✅"),
        result.out.includes(
          `❌ assistants/receptionist.model.tools[2].destinations[0]: an assistant target can't hand off to "scheduler"`,
        ),
      ],
      [2, true, true],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no vapi-checks.yml means nothing to check, and exits 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "check-cmd-"));
  try {
    assert.deepEqual(await run(["--all", "--dry-run"], root), {
      code: 0,
      out: "No vapi-checks.yml at the repository root; nothing to check.",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("usage, config and selection errors exit 2", async () => {
  const root = parityCopy();
  try {
    const codes = [
      (await run([], root)).code,
      (await run(["core", "--all", "--dry-run"], root)).code,
      (await run(["core", "--bogus"], root)).code,
      (await run(["nope", "--dry-run"], root)).code,
      // Live runs aren't available in this command yet.
      (await run(["core"], root)).code,
    ];
    writeFileSync(join(root, "vapi-checks.yml"), "version: 2\n");
    codes.push((await run(["core", "--dry-run"], root)).code);
    assert.deepEqual(codes, [2, 2, 2, 2, 2, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing state file is a warning, not an error", async () => {
  const root = parityCopy();
  try {
    rmSync(join(root, ".vapi-state.parity.json"));
    const result = await run(["core", "--dry-run"], root);
    assert.deepEqual(
      [
        result.code,
        result.out.includes("⚠️  no .vapi-state.parity.json"),
        existsSync(join(root, "tmp")),
      ],
      [0, true, false],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
