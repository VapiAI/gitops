// CLI entry: `npm run migrate`
//
// One-time migration of every org's state: from the legacy fat state file to
// the slim `name → { uuid }` form + the per-machine baseline store, and
// from the old root-level files into `state/<org>/`. Takes NO org argument and
// needs NO VAPI_TOKEN — it's a pure local file operation, so it deliberately
// does not import `config.ts` (which would force an org + token at load).
//
// Idempotent: re-running after migration seeds nothing and rewrites nothing.

import { resolve } from "path";
import { fileURLToPath } from "url";
import { migrateAll } from "./migrate-hash-store.ts";

async function main(): Promise<void> {
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log("🧬 Vapi GitOps Migrate — state files → state/<org>/");
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

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
    for (const notice of org.notices) console.log(`      ${notice}`);
  }

  console.log(
    `\n✅ Migration complete: ${result.orgs.length} org(s), ` +
      `${totalSlimmed} state file(s) slimmed, ${totalSeeded} baseline(s) seeded.`,
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
