// ─────────────────────────────────────────────────────────────────────────────
// Orphan-YAML pre-flight gate for `npm run push`.
//
// "Orphan YAML" = a local YAML/MD file whose slug has no entry in the state
// file. At push time this is ambiguous from the engine's perspective:
//
//   (a) NEW resource the user intentionally wants to create
//   (b) RENAME of an existing resource (state has the old slug; the YAML on
//       disk has the new name)
//   (c) MOVED file — file copied without the state entry being rekeyed
//
// Silently treating every orphan as case (a) is what produced the duplicate
// fleet we surfaced during the gitops-mudflap working session 2026-05-13.
// Flow F (`mv foo.md bar.md` + push), Flow G (dashboard rename → pull writes
// new file but leaves stale YAML), and Flow M (`apply` compresses Flow G into
// one click) all share this shape.
//
// Default-on gate. Halts push with a verbose error listing every orphan and
// pairing them with state-only "rename source" candidates by shared base
// slug. Override: `--allow-new-files`.
//
// Detection logic mirrors src/audit.ts's `checkOrphanYaml` — single source
// of truth for "what counts as an orphan YAML". Audit retains its own
// finding shape; this module exposes the inputs gate-formatted for the
// push CLI.
// ─────────────────────────────────────────────────────────────────────────────

import { extractBaseSlug, listExistingResourceIds } from "./pull.ts";
import { FOLDER_MAP } from "./resources.ts";
import type { ResourceType, StateFile } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface OrphanFile {
  type: ResourceType;
  resourceId: string;
  relativePath: string;
}

export interface RenameSource {
  type: ResourceType;
  resourceId: string;
  uuid: string;
}

export interface OrphanReport {
  orphans: OrphanFile[];
  possibleRenameSources: RenameSource[];
  scopedToPaths: boolean;
}

export interface DetectOrphanYamlsOptions {
  state: StateFile;
  types?: ResourceType[];
  // DI seam — defaults to filesystem walk via `listExistingResourceIds`.
  listLocalIds?: (t: ResourceType) => string[];
  // When provided, only orphans whose relativePath matches an entry in this
  // list are reported. Mirrors `APPLY_FILTER.filePaths` semantics used by
  // selective push.
  filePathFilter?: string[];
  // Optional override of `extractBaseSlug`. Defaults to the pull.ts helper
  // — only swapped in tests to keep the unit suite filesystem-free.
  extractBaseSlug?: (resourceId: string) => string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

// Shared predicate: "which local resourceIds for this type have NO state
// entry?" Both this module's gate and src/audit.ts's `checkOrphanYaml`
// delegate to this so the definition of "orphan YAML" stays unambiguous.
// Kept tiny on purpose — the value is in NOT having two copies of the
// stateKeys.has check drift apart.
export function findOrphanResourceIds(
  type: ResourceType,
  localIds: string[],
  state: StateFile,
): string[] {
  const stateKeys = new Set(Object.keys(state[type]));
  return localIds.filter((id) => !stateKeys.has(id));
}

function pathMatchesAnyFilter(
  relativePath: string,
  filters: string[],
  resourceId: string,
): boolean {
  for (const filter of filters) {
    if (filter === relativePath) return true;
    if (relativePath.endsWith(filter)) return true;
    if (filter.endsWith(relativePath)) return true;
    if (filter.endsWith(`${resourceId}.yml`)) return true;
    if (filter.endsWith(`${resourceId}.yaml`)) return true;
    if (filter.endsWith(`${resourceId}.md`)) return true;
  }
  return false;
}

// Detect orphan YAMLs across every resource type. Pairs them with possible
// rename SOURCES — state entries that have no matching local file AND share a
// base slug with at least one orphan. The pairing is heuristic (intended to
// surface candidates, not to auto-fix) so it errs toward listing more than
// strictly necessary.
export function detectOrphanYamls(
  opts: DetectOrphanYamlsOptions,
): OrphanReport {
  const {
    state,
    types = [...VALID_RESOURCE_TYPES],
    listLocalIds = listExistingResourceIds,
    filePathFilter,
    extractBaseSlug: baseSlugFn = extractBaseSlug,
  } = opts;

  const orphans: OrphanFile[] = [];
  // Track state entries that have no matching local file, grouped by type and
  // by base slug, so we can pair them with orphan YAMLs sharing that base.
  type StateOnlyEntry = {
    type: ResourceType;
    resourceId: string;
    uuid: string;
  };
  const stateOnlyByType = new Map<ResourceType, StateOnlyEntry[]>();
  // Base slugs that appear in the orphan set, per type. Used to filter the
  // rename-source candidates so we only surface plausible pairings.
  const orphanBaseSlugsByType = new Map<ResourceType, Set<string>>();

  const scopedToPaths = !!(filePathFilter && filePathFilter.length > 0);

  for (const type of types) {
    const folder = FOLDER_MAP[type];
    const localIds = listLocalIds(type);
    const orphanIds = findOrphanResourceIds(type, localIds, state);
    const localIdSet = new Set(localIds);

    // Pass 1: orphan YAMLs (local files with no state entry).
    for (const localId of orphanIds) {
      // Determine relative path. Files are loaded with one of {.yml, .yaml,
      // .md}; we don't have the actual extension on hand here because
      // `listExistingResourceIds` strips it. Use `.md` for assistants (per
      // convention) and `.yml` for everything else when reporting — this is
      // only for human-readable output, not for matching.
      const ext = type === "assistants" ? "md" : "yml";
      const relativePath = `resources/<org>/${folder}/${localId}.${ext}`;
      if (
        scopedToPaths &&
        !pathMatchesAnyFilter(
          `${folder}/${localId}.${ext}`,
          filePathFilter ?? [],
          localId,
        )
      ) {
        continue;
      }
      orphans.push({ type, resourceId: localId, relativePath });
      const baseSet = orphanBaseSlugsByType.get(type) ?? new Set<string>();
      baseSet.add(baseSlugFn(localId));
      orphanBaseSlugsByType.set(type, baseSet);
    }

    // Pass 2: state entries with no matching local file. We collect these per
    // type, then in Pass 3 pair them with orphans sharing a base slug.
    const stateOnly: StateOnlyEntry[] = [];
    for (const [resourceId, entry] of Object.entries(state[type])) {
      if (localIdSet.has(resourceId)) continue;
      stateOnly.push({ type, resourceId, uuid: entry.uuid });
    }
    if (stateOnly.length > 0) {
      stateOnlyByType.set(type, stateOnly);
    }
  }

  // Pass 3: rename-source candidates. For each state-only entry, surface it
  // as a candidate when its base slug matches at least one orphan in the same
  // type. Cross-type matches are uncommon enough that we ignore them — the
  // signal would be noisy.
  const possibleRenameSources: RenameSource[] = [];
  for (const [type, entries] of stateOnlyByType) {
    const orphanBases = orphanBaseSlugsByType.get(type);
    if (!orphanBases || orphanBases.size === 0) continue;
    for (const entry of entries) {
      const base = baseSlugFn(entry.resourceId);
      if (!orphanBases.has(base)) continue;
      possibleRenameSources.push(entry);
    }
  }

  return { orphans, possibleRenameSources, scopedToPaths };
}

// ─────────────────────────────────────────────────────────────────────────────
// Message formatting
//
// ANSI color codes emitted only when the caller passes `color: true` — for
// production this is gated on `process.stderr.isTTY` so pipes / CI logs /
// AI-agent stdout captures get plain text.
// ─────────────────────────────────────────────────────────────────────────────

interface AnsiPalette {
  red: string;
  yellow: string;
  bold: string;
  reset: string;
}

function buildPalette(color: boolean): AnsiPalette {
  if (!color) {
    return { red: "", yellow: "", bold: "", reset: "" };
  }
  return {
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
  };
}

export function formatGateMessage(
  report: OrphanReport,
  env: string,
  options: { color?: boolean } = {},
): string {
  const ansi = buildPalette(options.color === true);
  const { red, yellow, bold, reset } = ansi;

  const lines: string[] = [];
  const count = report.orphans.length;
  const scopeNote = report.scopedToPaths
    ? " (scoped to the selective-push file set)"
    : "";

  lines.push("");
  lines.push(
    `${red}${bold}❌ Push refused${reset}${red}: ${count} file(s) on disk have no state-file UUID mapping for env "${env}"${scopeNote}.${reset}`,
  );
  lines.push("");
  lines.push("The engine cannot tell whether each is:");
  lines.push("  - A NEW resource you intentionally want to create");
  lines.push(
    "  - A RENAME of an existing resource (state has the old slug; YAML has new name)",
  );
  lines.push("  - A MOVED file (file copied without state updated)");
  lines.push("");
  lines.push(`${bold}Files without state entry:${reset}`);
  for (const orphan of report.orphans) {
    lines.push(`  - ${orphan.relativePath}`);
  }

  lines.push("");
  if (report.possibleRenameSources.length === 0) {
    lines.push(
      `${bold}State entries with no matching local file (possible rename SOURCES):${reset}`,
    );
    lines.push("  (none — no plausible rename pairings found)");
  } else {
    lines.push(
      `${bold}State entries with no matching local file (possible rename SOURCES):${reset}`,
    );
    for (const src of report.possibleRenameSources) {
      const shortUuid =
        src.uuid.length > 8 ? `${src.uuid.slice(0, 8)}…` : src.uuid;
      lines.push(
        `  - ${src.type}/${src.resourceId} → ${shortUuid} (no ${src.resourceId} on disk)`,
      );
    }
  }

  lines.push("");
  lines.push(
    `${yellow}${bold}⚠️ FOR AI AGENTS reading this:${reset} do NOT auto-pass --allow-new-files. Pause`,
  );
  lines.push(
    "and ask the human to confirm, for EACH file above, whether it is:",
  );
  lines.push("  (a) intentionally new (then pass --allow-new-files)");
  lines.push(
    "  (b) a rename (then rename it back and use `npm run pull` to re-key",
  );
  lines.push("      state, or apply the rename explicitly)");
  lines.push("  (c) stale cruft (then delete the local file)");
  lines.push("");
  lines.push(
    "If the user is reachable, surface this gate to them. If running headless,",
  );
  lines.push(
    "abort. Silent --allow-new-files defeats the entire purpose of this gate.",
  );
  lines.push("");
  lines.push(
    `To proceed (after confirming intent for every file above): re-run with ${bold}--allow-new-files${reset}.`,
  );
  lines.push("");

  return lines.join("\n");
}
