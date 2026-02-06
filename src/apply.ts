import { execSync } from "child_process";
import type { ExecSyncOptionsWithStringEncoding } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─────────────────────────────────────────────────────────────────────────────
// Bidirectional Sync: pull platform changes, merge with local changes, push
//
// Flow:
//   1. Check for local uncommitted changes (git status)
//   2. If local changes exist, stash them
//   3. Pull platform state (npm run pull:<env>)
//   4. Commit the pulled state as a "platform sync" commit
//   5. Pop the stash (reapply local changes)
//   6. If merge conflicts, warn and exit for manual resolution
//   7. Push merged state to platform (npm run push:<env>)
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

const VALID_ENVIRONMENTS = ["dev", "staging", "prod"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const execOpts: ExecSyncOptionsWithStringEncoding = {
  cwd: BASE_DIR,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
};

function run(cmd: string, opts?: { silent?: boolean }): string {
  try {
    const output = execSync(cmd, execOpts).trim();
    if (!opts?.silent && output) {
      console.log(output);
    }
    return output;
  } catch (error: unknown) {
    const execError = error as { stderr?: string; stdout?: string; status?: number };
    const stderr = execError.stderr?.trim() || "";
    const stdout = execError.stdout?.trim() || "";
    throw new Error(`Command failed: ${cmd}\n${stderr}\n${stdout}`);
  }
}

function runPassthrough(cmd: string): number {
  try {
    execSync(cmd, { cwd: BASE_DIR, stdio: "inherit" });
    return 0;
  } catch (error: unknown) {
    const execError = error as { status?: number };
    return execError.status ?? 1;
  }
}

function hasLocalChanges(): boolean {
  const status = run("git status --porcelain", { silent: true });
  return status.length > 0;
}

function isGitRepo(): boolean {
  try {
    run("git rev-parse --is-inside-work-tree", { silent: true });
    return true;
  } catch {
    return false;
  }
}

function hasStash(): boolean {
  const stashList = run("git stash list", { silent: true });
  return stashList.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Sync Flow
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = process.argv[2];
  const extraArgs = process.argv.slice(3).join(" ");

  if (!env || !VALID_ENVIRONMENTS.includes(env as typeof VALID_ENVIRONMENTS[number])) {
    console.error("❌ Environment argument is required");
    console.error("   Usage: npm run apply:dev | apply:prod");
    console.error("");
    console.error("   This command performs a bidirectional sync:");
    console.error("   1. Stashes your local changes");
    console.error("   2. Pulls latest platform state");
    console.error("   3. Reapplies your local changes on top");
    console.error("   4. Pushes the merged result to the platform");
    console.error("");
    console.error("   For one-way push only, use: npm run push:dev | push:prod");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🔄 Vapi GitOps Sync - Environment: ${env}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Step 0: Ensure we're in a git repo
  if (!isGitRepo()) {
    console.error("❌ Not a git repository. Bidirectional sync requires git.");
    console.error("   Initialize with: git init && git add . && git commit -m 'initial'");
    console.error("   Or use 'npm run push:<env>' for direct push without git.\n");
    process.exit(1);
  }

  // Step 1: Check for local changes
  const hadLocalChanges = hasLocalChanges();

  if (hadLocalChanges) {
    console.log("📦 Local changes detected, stashing...\n");
    run("git stash push -m \"gitops-sync: local changes before pull\"");
    console.log("   ✅ Local changes stashed\n");
  } else {
    console.log("📦 No local changes to stash\n");
  }

  // Step 2: Pull platform state
  console.log("📥 Pulling platform state...\n");
  const pullExitCode = runPassthrough(`npx tsx src/pull.ts ${env}`);

  if (pullExitCode !== 0) {
    console.error("\n❌ Pull failed!");
    if (hadLocalChanges) {
      console.log("   Restoring your local changes from stash...");
      run("git stash pop");
    }
    process.exit(1);
  }

  // Step 3: Commit pulled state (if there are changes from the pull)
  if (hasLocalChanges()) {
    console.log("\n📝 Committing platform state...\n");
    run("git add -A");
    run(`git commit -m "sync: pull platform state (${env})"`);
    console.log("   ✅ Platform state committed\n");
  } else {
    console.log("\n📝 No platform changes to commit\n");
  }

  // Step 4: Pop stash (reapply local changes)
  if (hadLocalChanges) {
    console.log("📦 Reapplying local changes...\n");
    try {
      run("git stash pop");
      console.log("   ✅ Local changes reapplied\n");
    } catch (error) {
      // Merge conflict during stash pop
      console.error("\n⚠️  Merge conflicts detected!\n");
      console.error("   Your local changes conflict with platform changes.");
      console.error("   Please resolve the conflicts manually, then run:");
      console.error(`     git add . && npm run push:${env}\n`);
      console.error("   To see conflicted files:");
      console.error("     git diff --name-only --diff-filter=U\n");
      console.error("   To abort and restore your local changes:");
      console.error("     git checkout --theirs . && git stash pop\n");
      process.exit(1);
    }
  }

  // Step 5: Push merged state to platform
  console.log("🚀 Pushing merged state to platform...\n");
  const pushExitCode = runPassthrough(`npx tsx src/push.ts ${env} ${extraArgs}`.trim());

  if (pushExitCode !== 0) {
    console.error("\n❌ Push failed!");
    process.exit(1);
  }

  // Step 6: Commit the final state after push (state file may have changed)
  if (hasLocalChanges()) {
    console.log("\n📝 Committing final state...\n");
    run("git add -A");
    run(`git commit -m "sync: apply local changes to platform (${env})"`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ Bidirectional sync complete!");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

// Run the sync engine
main().catch((error) => {
  console.error("\n❌ Sync failed:", error);
  process.exit(1);
});
