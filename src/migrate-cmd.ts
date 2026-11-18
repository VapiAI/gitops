// CLI entry: `npm run migrate`
//
// One-time migration of every org's state: from the legacy fat state file to
// the slim `name → { uuid }` form + the per-machine baseline store, and
// from the old root-level files into `state/<org>/`. Takes NO org argument and
// needs NO VAPI_TOKEN — it's a pure local file operation, so it deliberately
// does not import `config.ts` (which would force an org + token at load).
//
// Idempotent: re-running after migration seeds nothing and rewrites nothing.
//
// `--commit-step-stages-state` is a person's word that whatever commits state
// after a run stages state/. It is only needed where the engine can't see
// that for itself, and without it nothing moves there.

import { resolve } from "path";
import { fileURLToPath } from "url";
import { migrateAll } from "./migrate-hash-store.ts";
import { COMMIT_STEP_FLAG } from "./state-paths.ts";

async function main(): Promise<void> {
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log("🧬 Vapi GitOps Migrate — state files → state/<org>/");
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== COMMIT_STEP_FLAG);
  if (unknown.length > 0)
    throw new Error(
      `Unrecognized argument: ${unknown.join(" ")}. The only option is ${COMMIT_STEP_FLAG}.`,
    );

  const result = await migrateAll(undefined, {
    commitStepStagesState: args.includes(COMMIT_STEP_FLAG),
  });
  if (result.acknowledged) console.log(`   ${result.acknowledged}\n`);

  if (result.orgs.length === 0) {
    console.log("   No state files found — nothing to migrate.");
    return;
  }

  let totalSeeded = 0;
  let totalSlimmed = 0;
  for (const org of result.orgs) {
    totalSeeded += org.seeded;
    if (org.slimmed) totalSlimmed++;
    const status = org.slimmed ? "migrated" : "already slim";
    console.log(
      `   ${org.slimmed ? "✅" : "✔️ "} ${org.stateFile} (${org.org}): ` +
        `${status} — seeded ${org.seeded} baseline(s)` +
        (org.skipped > 0 ? `, ${org.skipped} already present` : ""),
    );
    for (const notice of org.notices) console.log(`      ${notice}`);
  }

  console.log(
    `\n✅ Migration complete: ${result.orgs.length} org(s), ` +
      `${totalSlimmed} state file(s) slimmed, ${totalSeeded} baseline(s) seeded.`,
  );
  if (result.commitStepAsk) console.log(`\n${result.commitStepAsk.join("\n")}`);
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(
      "\n❌ Migration failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
