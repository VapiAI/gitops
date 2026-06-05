import { execSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { assertStateMigrated } from "./migrate-hash-store.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Apply: Pull → Merge → Push (safe bidirectional sync)
//
// 1. Pull latest platform state, merge with local changes (git stash/pop)
// 2. If merge is clean, push the result to the platform
// 3. If conflicts, stop — user resolves, then runs push manually
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function runPassthrough(cmd: string): number {
  try {
    execSync(cmd, { cwd: BASE_DIR, stdio: "inherit" });
    return 0;
  } catch (error: unknown) {
    return (error as { status?: number }).status ?? 1;
  }
}

export async function runApply(): Promise<void> {
  const env = process.argv[2];
  const allArgs = process.argv.slice(3);
  const hasForce = allArgs.includes("--force");

  // Fail fast with one clear message if this org's state file is still legacy,
  // rather than letting the spawned pull/push subprocess surface it later.
  if (env && SLUG_RE.test(env)) {
    assertStateMigrated(join(BASE_DIR, `.vapi-state.${env}.json`));
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
    console.error("Usage: npm run apply <org> [--force] [--allow-new-files] [--resolve=defer|ours|theirs|fail] [<file...>]");
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
      "  --allow-new-files  Bypass the orphan-YAML pre-flight gate (push stage).",
    );
    console.error(
      "                     Use only after confirming every local file without a",
    );
    console.error(
      "                     state entry is genuinely new — see src/new-file-gate.ts.",
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
  const validateExit = runPassthrough(validateCmd);
  if (validateExit !== 0) {
    console.error(
      "\n❌ Validation failed — fix the schema errors above before applying.",
    );
    process.exit(1);
  }

  const pullCmd = `npx tsx src/pull.ts ${env} ${pullArgs}`.trim();
  const pullExit = runPassthrough(pullCmd);
  if (pullExit !== 0) {
    console.error("\n❌ Pull had issues. Resolve conflicts before pushing.");
    process.exit(1);
  }

  console.log("\n🚀 Pushing merged state to platform...\n");
  const pushCmd = `npx tsx src/push.ts ${env} ${pushArgs}`.trim();
  const pushExit = runPassthrough(pushCmd);
  if (pushExit !== 0) {
    console.error("\n❌ Push failed!");
    process.exit(1);
  }

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
