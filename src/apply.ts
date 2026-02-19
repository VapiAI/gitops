import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─────────────────────────────────────────────────────────────────────────────
// Apply: Pull → Merge → Push (safe bidirectional sync)
//
// 1. Pull latest platform state, merge with local changes (git stash/pop)
// 2. If merge is clean, push the result to the platform
// 3. If conflicts, stop — user resolves, then runs push manually
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

const VALID_ENVIRONMENTS = ["dev", "stg", "prod"] as const;

function runPassthrough(cmd: string): number {
  try {
    execSync(cmd, { cwd: BASE_DIR, stdio: "inherit" });
    return 0;
  } catch (error: unknown) {
    return (error as { status?: number }).status ?? 1;
  }
}

async function main(): Promise<void> {
  const env = process.argv[2];
  const allArgs = process.argv.slice(3);
  const hasForce = allArgs.includes("--force");

  // Pull never gets --force (apply's pull should always preserve local changes/deletions)
  const pullArgs = allArgs.filter(a => a !== "--force").join(" ");
  const pushArgs = allArgs.join(" ");

  if (!env || !VALID_ENVIRONMENTS.includes(env as typeof VALID_ENVIRONMENTS[number])) {
    console.error("Usage: npm run apply:dev [--force]");
    console.error("");
    console.error("  Pull → Merge → Push (safe bidirectional sync)");
    console.error("");
    console.error("  Pulls latest platform state (preserving local changes),");
    console.error("  then pushes the result back to the platform.");
    console.error("");
    console.error("  --force   Enable deletions: resources you deleted locally");
    console.error("            will also be deleted from the platform.");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🔄 Vapi GitOps Apply - Environment: ${env}`);
  console.log("   Pull → Merge → Push");
  if (hasForce) {
    console.log("   ⚠️  Deletions enabled (--force)");
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Step 1: Pull (never forced — always preserves local deletions/changes)
  const pullCmd = `npx tsx src/pull.ts ${env} ${pullArgs}`.trim();
  const pullExit = runPassthrough(pullCmd);
  if (pullExit !== 0) {
    console.error("\n❌ Pull had issues. Resolve conflicts before pushing.");
    process.exit(1);
  }

  // Step 2: Push merged state (--force forwarded here for deletions)
  console.log("\n🚀 Pushing merged state to platform...\n");
  const pushCmd = `npx tsx src/push.ts ${env} ${pushArgs}`.trim();
  const pushExit = runPassthrough(pushCmd);
  if (pushExit !== 0) {
    console.error("\n❌ Push failed!");
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Apply complete! (Pull → Merge → Push)");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("\n❌ Apply failed:", error);
  process.exit(1);
});
