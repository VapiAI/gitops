// Pure serialization helpers for the state file (and snapshot files).
//
// Kept config-free so tests can import without triggering the CLI argument
// parser in `config.ts` (which `process.exit(1)`s when no env is supplied).

import { createHash } from "crypto";
import type { ResourceState } from "./types.ts";

// JSON.stringify replacer that emits object keys in alphabetical order at
// every nesting level. Without this, the state file diff includes pure
// reorderings every time a resource map gets rebuilt from multiple sources
// (push, pull, bootstrap) — about half the diff lines are insertion-order
// churn rather than semantic change. Reviewers stop reading state diffs
// closely as a result, which defeats the point of versioning the file.
//
// Arrays are returned as-is so existing array order (e.g. squad members,
// tool destinations) is preserved.
export function sortedKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}

// Canonicalize a value: sort object keys at every level, drop null/undefined
// leaves recursively, leave array order intact. Produces a stable shape
// regardless of insertion order or transient nullish leaves the API may
// emit. Used by content hashing and drift detection — kept here so the
// helpers stay co-located.
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const c = canonicalize(item);
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const c = canonicalize((value as Record<string, unknown>)[k]);
    if (c !== undefined) sorted[k] = c;
  }
  return sorted;
}

// Stable sha256 of a payload after canonicalization. Used for content drift
// detection — this helper populates the hashes; the drift detection layer
// consumes them.
export function hashPayload(payload: unknown): string {
  const canonical = canonicalize(payload);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// Wrap a legacy state value (bare string UUID) as a ResourceState. Returns
// undefined if the value isn't recognized — `loadState()` migrates the
// shape, so an unrecognized value at load time means a corrupt state file.
export function asResourceState(value: unknown): ResourceState | undefined {
  if (typeof value === "string") return { uuid: value };
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { uuid?: unknown }).uuid === "string"
  ) {
    return value as ResourceState;
  }
  return undefined;
}

// Update or create the ResourceState entry for a resource with new content
// hashes. Preserves whichever fields aren't being updated (e.g. setting
// lastPushedHash leaves lastPulledHash intact). Critical for drift
// detection — push must not stomp the lastPulledHash that pull populated.
export function upsertState(
  section: Record<string, ResourceState>,
  resourceId: string,
  patch: Partial<ResourceState> & { uuid: string },
): void {
  const existing = section[resourceId];
  section[resourceId] = {
    ...(existing ?? {}),
    ...patch,
  };
}

// Pronunciation-dictionary drop check. Detects when a dictionary attachment
// disappears from the platform between pulls. Two shapes are supported
// because Vapi exposes a different field per provider:
//
//   - 11labs (documented at
//     https://docs.vapi.ai/assistants/pronunciation-dictionaries):
//     `voice.pronunciationDictionaryLocators` — array of
//     { pronunciationDictionaryId, versionId }. Dashboard edits that
//     change the voice can drop entries from this array.
//
//   - Cartesia (passthrough; not in Vapi docs but observed in real customer
//     payloads): `voice.pronunciationDictId` — single string id. The
//     Cartesia voice-picker silently drops the field on voice change.
//
// Pure-data (no network) so safe to import in tests.
type VoiceLike = {
  voice?: {
    pronunciationDictId?: unknown;
    pronunciationDictionaryLocators?: unknown;
  };
};

function locatorsArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function checkPronunciationDictDrop(
  resourceId: string,
  priorPayload: unknown,
  newPayload: unknown,
): string | null {
  const priorVoice = (priorPayload as VoiceLike | undefined)?.voice;
  const newVoice = (newPayload as VoiceLike | undefined)?.voice;

  // Cartesia single-id form. Drops 1 → 0.
  if (
    priorVoice?.pronunciationDictId &&
    typeof priorVoice.pronunciationDictId === "string" &&
    !newVoice?.pronunciationDictId
  ) {
    return (
      `   ⚠️  ${resourceId}: voice.pronunciationDictId was "${priorVoice.pronunciationDictId}" ` +
      `at last pull but is missing on platform now. ` +
      `Cartesia voice picker drops this silently — re-attach if needed.`
    );
  }

  // 11labs locator-array form. Catches array clears (N → 0) and shrinks
  // (N → M, M < N). A drop from 0 → 0 (or undefined → undefined) is a
  // no-op and rightly returns null.
  const priorLocators = locatorsArray(
    priorVoice?.pronunciationDictionaryLocators,
  );
  if (priorLocators.length > 0) {
    const newLocators = locatorsArray(
      newVoice?.pronunciationDictionaryLocators,
    );
    if (newLocators.length < priorLocators.length) {
      return (
        `   ⚠️  ${resourceId}: voice.pronunciationDictionaryLocators dropped from ` +
        `${priorLocators.length} entry/entries at last pull to ${newLocators.length} on platform now. ` +
        `11labs dashboard voice edits can drop these silently — re-attach if needed.`
      );
    }
  }

  return null;
}
