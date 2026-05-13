// CLI entry: `npm run audit -- <org>`
//
// Read-only audit for the state-vs-dashboard drift conditions that have been
// accumulating cruft in customer-fork repos. Mirrors `src/validate-cmd.ts` for
// argument parsing and env banner so the operator experience is consistent
// across the engine.
//
// Exit code: 0 if no findings, 1 if any (warn or error). No `--strict` flag in
// v1 — a single severity bar keeps the surface small while we observe what
// shows up in real customer state.

import { resolve } from "path";
import { fileURLToPath } from "url";
import {
  type AuditFinding,
  formatFinding,
  runAudit,
  summarizeFindings,
} from "./audit.ts";
import { APPLY_FILTER, VAPI_BASE_URL, VAPI_ENV } from "./config.ts";
import type { ResourceType } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

// Single source of truth for the exit-code contract. Exported so tests can pin
// behavior without duplicating the predicate.
export function exitCodeForFindings(findings: AuditFinding[]): 0 | 1 {
  return findings.length === 0 ? 0 : 1;
}

function groupFindings(
  findings: AuditFinding[],
): Map<ResourceType, AuditFinding[]> {
  const grouped = new Map<ResourceType, AuditFinding[]>();
  for (const f of findings) {
    const arr = grouped.get(f.type) ?? [];
    arr.push(f);
    grouped.set(f.type, arr);
  }
  // Stable inner ordering: by rule, then by first resourceId.
  for (const arr of grouped.values()) {
    arr.sort((a, b) => {
      if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
      const aFirst = a.resourceIds[0] ?? "";
      const bFirst = b.resourceIds[0] ?? "";
      return aFirst.localeCompare(bFirst);
    });
  }
  return grouped;
}

async function main(): Promise<void> {
  console.log(
    "═══════════════════════════════════════════════════════════════",
  );
  console.log(`🔎 Vapi GitOps Audit - Environment: ${VAPI_ENV}`);
  console.log(`   API: ${VAPI_BASE_URL}`);
  console.log(
    "═══════════════════════════════════════════════════════════════\n",
  );

  // Respect --type filter (parsed by config.ts into APPLY_FILTER). When the
  // operator passes one or more --type flags we audit only those types; the
  // default sweep covers every entry in VALID_RESOURCE_TYPES.
  const types: ResourceType[] = APPLY_FILTER.resourceTypes?.length
    ? APPLY_FILTER.resourceTypes
    : [...VALID_RESOURCE_TYPES];

  if (APPLY_FILTER.resourceTypes?.length) {
    console.log(`🔧 Type filter: ${types.join(", ")}\n`);
  }

  const findings = await runAudit({ types });

  console.log(summarizeFindings(findings));

  if (exitCodeForFindings(findings) === 0) {
    process.exit(0);
  }

  // Group findings by resource type → rule for human-readable output.
  const grouped = groupFindings(findings);

  // Iterate types in the configured filter order so the operator can scan top-down.
  for (const type of types) {
    const arr = grouped.get(type);
    if (!arr?.length) continue;
    console.log(`\n${type} (${arr.length} finding(s)):`);
    for (const f of arr) {
      console.log(formatFinding(f));
    }
  }

  // Any finding → exit 1. v1 has no --strict gate; a warning still indicates
  // operator-actionable drift.
  process.exit(exitCodeForFindings(findings));
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(
      "\n❌ Audit failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
