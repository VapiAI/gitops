// ─────────────────────────────────────────────────────────────────────────────
// State key recanonicalization — generic across all resource types.
//
// The pull engine generates UUID-suffixed state keys (`<base>-<uuid8>`) when
// name-collision adoption is refused (src/pull.ts:findExistingResourceId /
// generateResourceId). That rekey is fire-and-forget: once the underlying
// collision resolves (e.g. the conflicting twin is deleted on the dashboard),
// nothing ever collapses the UUID-suffixed entry back to its canonical slug.
//
// Without this collapse, subsequent pushes treat the canonical-slug local
// file as a brand-new resource (orphan-YAML), and the operator either hits
// the orphan-YAML gate (#30) and bypasses with `--allow-new-files`, or — in
// older engine versions — silently creates a third dashboard duplicate.
//
// This module runs a safe collapse pass at end-of-pull and start-of-push.
// The pass is resource-type-agnostic: it walks every section of StateFile
// uniformly, so adding a new ResourceType doesn't need a code change here.
//
// SAFETY MODEL — every rekey must satisfy all five preconditions:
//   1. Key matches `^(.+)-([0-9a-f]{8})$` — the engine's generated shape.
//   2. The captured `<uuid8>` matches the entry's UUID prefix. This rules
//      out resources whose user-given names legitimately end in
//      `-abcd1234`. We only touch keys we can prove the engine wrote.
//   3. Canonical slug `<base>` is unclaimed in the SAME state section.
//      Prevents collision when a same-name twin is intentionally tracked.
//   4. A local file exists at `<base>` with any extension recognized by
//      the resource loader (`VALID_EXTENSIONS` in src/resources.ts —
//      .yml/.yaml/.ts/.md). Prevents creating phantom state mappings to
//      slugs that have no source file. The extension set is imported, not
//      hardcoded here, so the precondition stays in lockstep with the
//      loader; any future loader extension is automatically respected.
//   5. NO local file exists at `<base>-<uuid8>` under any
//      `VALID_EXTENSIONS` shape. The UUID-suffixed file represents a
//      different content snapshot; rekeying state without consolidating
//      files would silently reassign which file PATCHes which dashboard
//      UUID — the data-loss shape we are explicitly refusing to introduce.
//
// When (5) fails we surface a CONFLICT (both files exist, ambiguous which
// owns the dashboard UUID) so the operator can resolve it manually. We
// never auto-pick a winner — silent data loss is worse than a duplicate.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync } from "fs";
import { join } from "path";
import { RESOURCES_DIR } from "./config.ts";
import { FOLDER_MAP, VALID_EXTENSIONS } from "./resources.ts";
import { isEngineSuffixedSlug } from "./slug-utils.ts";
import type { TouchedSets } from "./state-merge.ts";
import type { ResourceType, StateFile } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

export interface RecanonicalizeRekey {
  type: ResourceType;
  fromKey: string;
  toKey: string;
  uuid: string;
}

export interface RecanonicalizeConflict {
  type: ResourceType;
  uuidSuffixedKey: string;
  canonicalKey: string;
  reason:
    | "canonical-slug-claimed-by-different-uuid"
    | "both-local-files-exist"
    | "canonical-local-file-missing";
  uuid: string;
}

export interface RecanonicalizeReport {
  rekeys: RecanonicalizeRekey[];
  conflicts: RecanonicalizeConflict[];
}

export interface RecanonicalizeOptions {
  state: StateFile;
  // DI seam — defaults to filesystem check rooted at `RESOURCES_DIR`. Tests
  // pass a stub so they don't need a fixture tree.
  fileExists?: (relativePath: string) => boolean;
  // Restrict the pass to specific types (default: all).
  types?: ResourceType[];
  // Optional `touched` set for scoped pushes. When provided, both the
  // deleted UUID-suffixed key AND the new canonical key are marked so
  // `mergeScoped` flushes the rename instead of silently re-persisting the
  // on-disk stale key. Pull doesn't pass this — it saves wholesale.
  touched?: TouchedSets;
}

function defaultFileExists(relativePath: string): boolean {
  return existsSync(join(RESOURCES_DIR, relativePath));
}

function localFileExistsForId(
  type: ResourceType,
  resourceId: string,
  fileExists: (relativePath: string) => boolean,
): boolean {
  const folder = FOLDER_MAP[type];
  for (const ext of VALID_EXTENSIONS) {
    if (fileExists(`${folder}/${resourceId}${ext}`)) return true;
  }
  return false;
}

// Mutates `state` in place. Returns the list of changes for logging and the
// list of unresolved conflicts the operator should see. Callers decide
// whether conflicts halt the run (push) or are advisory (pull).
export function recanonicalizeStateKeys(
  opts: RecanonicalizeOptions,
): RecanonicalizeReport {
  const {
    state,
    fileExists = defaultFileExists,
    types = [...VALID_RESOURCE_TYPES],
    touched,
  } = opts;

  const rekeys: RecanonicalizeRekey[] = [];
  const conflicts: RecanonicalizeConflict[] = [];

  const markTouched = (type: ResourceType, key: string): void => {
    if (touched) touched[type].add(key);
  };

  for (const type of types) {
    const section = state[type];
    if (!section) continue;

    // Snapshot keys upfront so we can mutate the section during iteration.
    for (const stateKey of Object.keys(section)) {
      const entry = section[stateKey];
      if (!entry) continue;

      // Preconditions 1 + 2 — the key must match the engine-generated
      // shape `<base>-<uuid8>` AND the captured 8-hex must match the
      // entry's UUID prefix. `isEngineSuffixedSlug` returns `null` on
      // either failure, ruling out user-named resources that
      // coincidentally end in `-abcd1234`.
      const parsed = isEngineSuffixedSlug(stateKey, entry.uuid);
      if (!parsed) continue;
      const canonicalSlug = parsed.base;

      // Precondition 3 — canonical slot must be unclaimed in state.
      //
      // Special case: if the canonical slot is claimed by the SAME UUID,
      // both keys are aliases for one dashboard resource. This shape is
      // produced by older engine versions that wrote duplicate-aliased
      // state, or by a `mergeScoped` round-trip before recanonicalize was
      // touched-aware. Safe action: drop the redundant UUID-suffixed key
      // (canonical wins; its metadata is presumed more authoritative).
      // This is auto-resolved as a rekey for reporting purposes.
      const claimedEntry = section[canonicalSlug];
      if (claimedEntry !== undefined) {
        if (claimedEntry.uuid === entry.uuid) {
          delete section[stateKey];
          markTouched(type, stateKey);
          markTouched(type, canonicalSlug);
          rekeys.push({
            type,
            fromKey: stateKey,
            toKey: canonicalSlug,
            uuid: entry.uuid,
          });
          continue;
        }
        // Genuinely a different UUID — same-name twin tracked legitimately.
        conflicts.push({
          type,
          uuidSuffixedKey: stateKey,
          canonicalKey: canonicalSlug,
          reason: "canonical-slug-claimed-by-different-uuid",
          uuid: entry.uuid,
        });
        continue;
      }

      // Precondition 4 — canonical local file must exist. Otherwise we'd
      // be inventing a state mapping that has no source on disk.
      const canonicalFileExists = localFileExistsForId(
        type,
        canonicalSlug,
        fileExists,
      );
      if (!canonicalFileExists) {
        conflicts.push({
          type,
          uuidSuffixedKey: stateKey,
          canonicalKey: canonicalSlug,
          reason: "canonical-local-file-missing",
          uuid: entry.uuid,
        });
        continue;
      }

      // Precondition 5 — UUID-suffixed local file must NOT exist. If both
      // files exist they represent different content snapshots; silently
      // rekeying would change which file PATCHes which dashboard UUID.
      const uuidSuffixedFileExists = localFileExistsForId(
        type,
        stateKey,
        fileExists,
      );
      if (uuidSuffixedFileExists) {
        conflicts.push({
          type,
          uuidSuffixedKey: stateKey,
          canonicalKey: canonicalSlug,
          reason: "both-local-files-exist",
          uuid: entry.uuid,
        });
        continue;
      }

      // All preconditions met — collapse. Mark BOTH the deleted UUID-suffixed
      // key AND the new canonical key as touched, so scoped pushes flush the
      // rename via `mergeScoped` instead of silently re-persisting the
      // on-disk stale key.
      section[canonicalSlug] = entry;
      delete section[stateKey];
      markTouched(type, stateKey);
      markTouched(type, canonicalSlug);
      rekeys.push({
        type,
        fromKey: stateKey,
        toKey: canonicalSlug,
        uuid: entry.uuid,
      });
    }
  }

  return { rekeys, conflicts };
}

// Human-readable summary for stdout. Empty report renders nothing — callers
// can unconditionally log.
export function formatRecanonicalizeReport(
  report: RecanonicalizeReport,
): string {
  if (report.rekeys.length === 0 && report.conflicts.length === 0) return "";

  const lines: string[] = [];
  if (report.rekeys.length > 0) {
    lines.push(
      `🔧 Recanonicalized ${report.rekeys.length} state key(s) — collapsed UUID-suffixed slug back to canonical:`,
    );
    for (const r of report.rekeys) {
      lines.push(`   ${r.type}/${r.fromKey} → ${r.type}/${r.toKey}`);
    }
  }
  if (report.conflicts.length > 0) {
    lines.push(
      `⚠️  ${report.conflicts.length} UUID-suffixed state key(s) NOT recanonicalized (manual resolution required):`,
    );
    for (const c of report.conflicts) {
      const hint =
        c.reason === "canonical-slug-claimed-by-different-uuid"
          ? `canonical slug ${c.canonicalKey} already claimed by a different dashboard UUID (legitimate same-name twin)`
          : c.reason === "both-local-files-exist"
            ? `both ${c.canonicalKey}.{yml,yaml,ts,md} and ${c.uuidSuffixedKey}.{yml,yaml,ts,md} exist — pick one and delete the other before next push`
            : `no local file at ${c.canonicalKey}.{yml,yaml,ts,md} — state entry is stale; either restore the file or remove the state entry`;
      lines.push(`   ${c.type}/${c.uuidSuffixedKey}: ${hint}`);
    }
  }
  return lines.join("\n");
}
