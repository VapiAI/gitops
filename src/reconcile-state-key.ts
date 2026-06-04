// Generic state-key reconciliation for auto-applied dependencies.
//
// Both `ensureToolExists` and `ensureStructuredOutputExists` in `push.ts`
// share a 94-line body that:
//
//   1. Probes for an existing dashboard / state resource whose canonical
//      name matches the local payload (`findExistingResourceByName`), so a
//      bootstrap-renamed state entry (`<slug>-<uuid8>`) or a live dashboard
//      twin isn't shadowed by a brand-new POST.
//   2. On match: rekeys state to the adopted UUID, runs the orphan-deletion
//      guard (drop OTHER state keys pointing at the same UUID so a
//      subsequent push doesn't DELETE the freshly-adopted dashboard
//      resource), and PATCHes via the standard apply path so drift
//      detection fires.
//   3. On no match: logs the auto-apply line and runs the standard apply
//      path (which creates).
//   4. In BOTH branches: records `autoApplied` even when the apply returns
//      `null` (the apply-path short-circuit that signals "skipped"), then
//      conditionally updates state with the post-PATCH hash, increments the
//      applied counter, pushes onto the per-type bookkeeping array, and
//      marks the local resourceId touched.
//
// The two functions differ only in: resource type label (singular + plural
// for log lines), state section, remote list fetcher, the per-type counter
// in `applied`, the per-type bookkeeping array, and the apply function.
// This module extracts the shared body — narrowed to `tools` /
// `structuredOutputs` because those are the only two auto-apply paths in
// the engine today.

import type { RemoteResource } from "./dep-dedup.ts";
import {
  extractResourceName,
  findExistingResourceByName,
} from "./dep-dedup.ts";
import { upsertState } from "./state.ts";
import type { TouchedSets } from "./state-merge.ts";
import type { ResourceFile, ResourceType, StateFile } from "./types.ts";

// The two resource types that flow through the auto-apply path. Adding a
// new caller (e.g. simulations) is a one-line union widening.
export type ReconcileResourceType = "tools" | "structuredOutputs";

// Per-type display labels used in the three log lines this helper emits.
// `singular` populates the "Reusing existing X" / "→ X" lines; `plural`
// populates the ambiguous-match warning ("Multiple dashboard Xs share the
// name").
const LABELS: Record<
  ReconcileResourceType,
  { singular: string; plural: string }
> = {
  tools: { singular: "tool", plural: "dashboard tools" },
  structuredOutputs: {
    singular: "structured output",
    plural: "dashboard structured outputs",
  },
};

export interface ReconcileStateKeyOptions {
  resourceType: ReconcileResourceType;
  resource: ResourceFile<Record<string, unknown>>;
  state: StateFile;
  touched: TouchedSets;
  // Per-type counter map (incremented on a non-null apply result). The
  // shape mirrors `DependencyContext.applied` so callers can pass it
  // directly without remapping.
  applied: Record<ResourceType, number>;
  // Cross-type Set of `${resourceType}:${resourceId}` keys for run-scoped
  // idempotency. The apply path adds to this set BEFORE checking the apply
  // result, matching the legacy behavior — see "applyFn null semantics" in
  // the PR description.
  autoApplied: Set<string>;
  // Callback for the per-type bookkeeping array
  // (`ctx.autoAppliedTools` / `ctx.autoAppliedStructuredOutputs`). Wrapped
  // as a callback so this module stays decoupled from `DependencyContext`.
  pushToAutoAppliedList: (
    resource: ResourceFile<Record<string, unknown>>,
  ) => void;
  // Lazy fetcher for the live dashboard inventory used in the dedup check.
  // Callers cache the result inside `DependencyContext` so it fires at most
  // once per push.
  getRemoteList: () => Promise<RemoteResource[]>;
  // The standard apply pipeline for this resource type. Returns the
  // post-PATCH UUID, or `null` when the apply was skipped (e.g. dry-run,
  // dependency unresolved, drift-check halt) — in which case `autoApplied`
  // is still recorded but the state-update / counter / bookkeeping steps
  // are SKIPPED. Matches the legacy `ensureToolExists` /
  // `ensureStructuredOutputExists` semantics exactly.
  applyFn: (resource: ResourceFile, state: StateFile) => Promise<string | null>;
  // Surfaced in the ambiguous-match warning to direct the operator at the
  // right cleanup command. Required so a future caller (e.g. a sims
  // auto-apply path) can't omit it and emit `npm run cleanup -- <env>`
  // verbatim to a confused operator. Tests pass `"test-env"`.
  vapiEnv: string;
  // Format errors uniformly with the rest of the push pipeline. Required
  // for the same future-caller-safety reason as `vapiEnv` — production
  // callers MUST inject `formatApiError` from push.ts so VapiApiError
  // breakouts render with status code + endpoint, not a degraded
  // `Error.message`-only fallback.
  formatError: (resourceId: string, error: unknown) => string;
}

export async function reconcileStateKeyForResource(
  opts: ReconcileStateKeyOptions,
): Promise<void> {
  const {
    resourceType,
    resource,
    state,
    touched,
    applied,
    autoApplied,
    pushToAutoAppliedList,
    getRemoteList,
    applyFn,
    vapiEnv,
    formatError,
  } = opts;

  const { singular, plural } = LABELS[resourceType];
  const stateSection = state[resourceType];
  const touchedSection = touched[resourceType];
  const resourceId = resource.resourceId;
  const autoAppliedKey = `${resourceType}:${resourceId}`;

  // Before creating, check whether an existing state entry (under a
  // different key — e.g., bootstrap-generated `<slug>-<uuid8>`) or a live
  // dashboard resource already represents this same logical resource.
  // Adopt instead of minting a duplicate.
  const remoteList = await getRemoteList();
  const match = findExistingResourceByName({
    localResourceId: resourceId,
    localPayload: resource.data,
    stateSection,
    remoteList,
  });

  if (match) {
    if (match.ambiguous) {
      const displayName = extractResourceName(resource.data) ?? resourceId;
      console.warn(
        `  ⚠️  Multiple ${plural} share the name "${displayName}" — adopting ${match.uuid} (lex-smallest). Other UUIDs: ${match.duplicateUuids.join(", ")}. Run \`npm run cleanup -- ${vapiEnv}\` to prune duplicates.`,
      );
    }
    console.log(
      `  🔁 Reusing existing ${singular}: ${resourceId} → ${match.uuid} (matched via ${match.source})`,
    );

    // Re-key state to point at the adopted UUID under the local resourceId.
    // No hash yet — `applyFn` below will PATCH with the local payload and
    // record the post-PATCH hash, exercising the standard drift-check flow.
    upsertState(stateSection, resourceId, { uuid: match.uuid });

    // Orphan-deletion guard — drop other state keys pointing at the SAME
    // uuid so a subsequent full push doesn't see them as "tracked but no
    // local file" and DELETE the dashboard resource we just adopted. Mark
    // them touched so the scoped state-merge on save flushes the deletion.
    // Entries pointing at `match.duplicateUuids` are SEPARATE dashboard
    // duplicates — leave them alone; `npm run cleanup` handles those.
    for (const [staleKey, entry] of Object.entries(stateSection)) {
      if (staleKey !== resourceId && entry.uuid === match.uuid) {
        delete stateSection[staleKey];
        touchedSection.add(staleKey);
      }
    }

    // PATCH the dashboard with the local payload. The apply function's
    // `upsertResourceWithStateRecovery` branch picks PATCH because the
    // state section now has `existingUuid` set. Drift check fires
    // (no-baseline → log + proceed when `lastPulledHash` is undefined;
    // full check when it isn't).
    try {
      const uuid = await applyFn(resource, state);
      autoApplied.add(autoAppliedKey);
      if (!uuid) return;
      upsertState(stateSection, resourceId, {
        uuid,
      });
      applied[resourceType]++;
      pushToAutoAppliedList(resource);
      touchedSection.add(resourceId);
    } catch (error) {
      console.error(formatError(resourceId, error));
      throw error;
    }
    return;
  }

  console.log(`  📦 Auto-applying dependency → ${singular}: ${resourceId}`);
  try {
    const uuid = await applyFn(resource, state);
    autoApplied.add(autoAppliedKey);
    if (!uuid) return;
    upsertState(stateSection, resourceId, {
      uuid,
    });
    applied[resourceType]++;
    pushToAutoAppliedList(resource);
    touchedSection.add(resourceId);
  } catch (error) {
    console.error(formatError(resourceId, error));
    throw error;
  }
}
