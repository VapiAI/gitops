import { execSync } from "child_process";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { parseAdoptArgs } from "./adopt.ts";
import { baseDir } from "./base-dir.ts";
import { assertStateMigrated } from "./migrate-hash-store.ts";
import {
  stateFileRead,
  stateLayoutPrepare,
  stateNoticesPrint,
} from "./state-paths.ts";
// Pins this command's User-Agent label for the pull and push it spawns.
import "./user-agent.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Apply: Pull → Merge → Push (safe bidirectional sync)
//
// 1. Pull latest platform state, merge with local changes (git stash/pop)
// 2. If merge is clean, push the result to the platform
// 3. If conflicts, stop — user resolves, then runs push manually
// ─────────────────────────────────────────────────────────────────────────────

const BASE_DIR = baseDir();

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function runPassthrough(cmd: string, quiet = false): number {
  try {
    execSync(cmd, {
      cwd: BASE_DIR,
      stdio: quiet ? ["inherit", 2, 2] : "inherit",
    });
    return 0;
  } catch (error: unknown) {
    return (error as { status?: number }).status ?? 1;
  }
}

export async function runApply(): Promise<void> {
  const output = console.log.bind(console);
  const json = process.argv.includes("--json");
  if (json) console.log = console.error.bind(console);
  const env = process.argv[2];
  const allArgs = process.argv.slice(3);
  parseAdoptArgs(allArgs);
  const hasForce = allArgs.includes("--force");
  const dryRun = allArgs.includes("--dry-run");

  // Check the org's state layout once, here, and fail fast with one clear
  // message if the state file is still in the legacy format, rather than
  // letting the spawned pull/push subprocess surface either later. What is
  // printed here is not printed again by the pull and push below.
  if (env && SLUG_RE.test(env)) {
    stateNoticesPrint(stateLayoutPrepare(BASE_DIR, env));
    assertStateMigrated(stateFileRead(BASE_DIR, env));
  }

  // Default drift resolution is "defer": pull preserves the local file AND
  // the drift baseline for conflicted resources, and the push stage asks a
  // per-resource question for exactly the resources that actually diverged
  // (its stdio is inherited, so the prompt reaches the operator). No umbrella
  // decision is made up front. Explicit --resolve=ours|theirs|fail keeps the
  // non-interactive (CI) semantics — including ours → push --overwrite.
  const pullArgsList = allArgs.filter((a) => a !== "--force");
  if (!pullArgsList.some((a) => a.startsWith("--resolve="))) {
    pullArgsList.push("--resolve=defer");
  }
  const resolveArg = pullArgsList.find((a) => a.startsWith("--resolve="));
  const resolveMode = resolveArg?.slice("--resolve=".length) ?? "defer";

  const pullArgs = pullArgsList.join(" ");

  // Explicit --resolve=ours means "keep local and push it up, no questions" —
  // push needs --overwrite so its pre-PATCH drift gate doesn't block (or
  // re-ask about) the same intent.
  const pushArgsList = [...allArgs];
  if (
    resolveMode === "ours" &&
    !pushArgsList.includes("--overwrite") &&
    !pushArgsList.includes("--dry-run")
  ) {
    pushArgsList.push("--overwrite");
  }
  const pushArgs = pushArgsList.join(" ");

  if (!env || !SLUG_RE.test(env)) {
    console.error(
      "Usage: npm run apply <org> [--force] [--allow-new-files] [--resolve=defer|ours|theirs|fail] [<file...>]",
    );
    console.error("");
    console.error("  Pull → Merge → Push (safe bidirectional sync)");
    console.error("");
    console.error("  Pulls latest platform state (preserving local changes),");
    console.error("  then pushes the result back to the platform.");
    console.error("");
    console.error(
      "  --force            Enable deletions: resources you deleted locally",
    );
    console.error(
      "                     will also be deleted from the platform.",
    );
    console.error(
      "  --allow-new-files  Approve creating resources for unlinked files (push stage).",
    );
    console.error(
      "                     Use only after confirming every local file without a",
    );
    console.error(
      "                     state entry is genuinely new — see src/new-file-gate.ts.",
    );
    console.error(
      "  --adopt <id>[=<uuid>]  Explicitly take over a remote resource (repeatable).",
    );
    console.error(
      "  --json             Print the link-preflight report as a JSON array on stdout.",
    );
    console.error(
      "  --resolve=defer    On 3-way drift, ask per resource at push time (default).",
    );
    console.error(
      "  --resolve=ours     On 3-way drift, keep local and push up, no questions (adds --overwrite on push).",
    );
    console.error(
      "  --resolve=theirs   On 3-way drift, overwrite local with dashboard.",
    );
    console.error(
      "  --resolve=fail     On 3-way drift, exit without writing (CI mode).",
    );
    process.exit(1);
  }

  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🔄 Vapi GitOps Apply - Environment: ${env}`);
  console.log("   Validate → Pull → Merge → Push");
  if (hasForce) {
    console.log("   ⚠️  Deletions enabled (--force)");
  }
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  // Apply is the one-shot safe deploy verb: run the local schema validators
  // first so a shape error never burns a pull/push cycle. No network call —
  // this is the same check as `npm run validate`, just built in. It stays
  // available standalone for CI / pre-flight use.
  const validateCmd = `npx tsx src/validate-cmd.ts ${env}`;
  const validateExit = runPassthrough(validateCmd, json);
  if (validateExit !== 0) {
    console.error(
      "\n❌ Validation failed — fix the schema errors above before applying.",
    );
    process.exit(1);
  }

  const pullCmd = `npx tsx src/pull.ts ${env} ${pullArgs}`.trim();
  const { preflightApplyLinks } = await import("./adopt-apply-preflight.ts");
  await preflightApplyLinks(output);
  if (dryRun)
    console.log(
      "\n🧪 Dry-run: skipping pull to preserve local files and state.",
    );
  const pullExit = dryRun ? 0 : runPassthrough(pullCmd, json);
  if (pullExit !== 0) {
    console.error("\n❌ Pull had issues. Resolve conflicts before pushing.");
    process.exit(1);
  }

  console.log("\n🚀 Pushing merged state to platform...\n");
  const pushCmd = `npx tsx src/push.ts ${env} ${pushArgs}`.trim();
  const pushExit = runPassthrough(pushCmd);
  if (pushExit !== 0) {
    process.exit(1);
  }

  if (dryRun) return;

  console.log(
    "\n═══════════════════════════════════════════════════════════════",
  );
  console.log("✅ Apply complete! (Pull → Merge → Push)");
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );
}

// Run when executed directly
const isMainModule =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runApply().catch((error) => {
    console.error("\n❌ Apply failed:", error);
    process.exit(1);
  });
}
