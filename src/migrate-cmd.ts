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
// This is the only command that moves committed state. Before it moves
// anything it says what the step that commits state after a run has to stage.
//
// `--commit-step-stages-state` is a person's word that whatever commits state
// after a run stages state/. It is only needed where the engine can't see
// that for itself, and without it nothing moves there.

import { resolve } from "path";
import { fileURLToPath } from "url";
import { HASH_STORE_BASE_DIR } from "./hash-store.ts";
import { migrateAll, migrateMovedLine } from "./migrate-hash-store.ts";
import {
  COMMIT_STEP_FLAG,
  commitStepAcknowledge,
  stateLayout,
  stateMoveRead,
  stateOrgsList,
} from "./state-paths.ts";

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

  if (args.includes(COMMIT_STEP_FLAG))
    console.log(`${commitStepAcknowledge(HASH_STORE_BASE_DIR)}\n`);
  // Said before anything moves, and only when there is something to move.
  const toMove = stateOrgsList(HASH_STORE_BASE_DIR).some(
    (org) => stateLayout(HASH_STORE_BASE_DIR, org) === "root",
  );
  const move = stateMoveRead(HASH_STORE_BASE_DIR);
  if (toMove) console.log(`${move.lines.join("\n")}\n`);

  const result = await migrateAll();

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
    const moved = migrateMovedLine(org);
    if (moved) console.log(`      ${moved}`);
  }

  console.log(
    `\n✅ Migration complete: ${result.orgs.length} org(s), ` +
      `${totalSlimmed} state file(s) slimmed, ${totalSeeded} baseline(s) seeded.`,
  );
  if (toMove && !move.open)
    console.log(
      "⚠️  State stays where it is. What the commit step needs first is above.",
    );
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
