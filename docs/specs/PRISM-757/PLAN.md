# Plan: Add GitOps Support for Pronunciation Dictionaries

## Overview

This feature adds first-class GitOps management for Vapi pronunciation dictionaries in the `VapiAI/gitops` repository. Today, pronunciation dictionaries are created and managed exclusively through the Vapi API or dashboard -- outside the gitops flow -- even though assistants reference them in voice configs. This creates a gap: every other resource an assistant depends on (tools, structured outputs, credentials) is either tracked in state or managed as a local file, but dictionaries are fire-and-forget API objects with no local source of truth, no version history, and no diff-reviewable change trail.

The implementation introduces a new `pronunciationDictionaries` resource type that lives at `resources/<org>/pronunciationDictionaries/`. Each dictionary file supports multiple named versions with an explicit `activeVersion` pointer, covering both ElevenLabs and Cartesia provider formats. The push flow creates dictionaries when missing, PATCHes the provider dictionary when the active version's content changes, and no-ops when nothing has changed. The pull flow materializes remote dictionaries into local files. State tracks both the Vapi wrapper UUID (used for PATCH/DELETE endpoints) and the provider-specific dictionary/version IDs (used in assistant voice fields). During push, assistant voice configs that reference local dictionary IDs are resolved to the provider-compatible fields (`pronunciationDictionaryLocators` for 11labs, `pronunciationDictId` for Cartesia).

This fits naturally into the existing engine architecture: `FOLDER_MAP`, `VALID_RESOURCE_TYPES`, `ResourceType`, `StateFile`, `LoadedResources`, `TouchedSets`, and the apply/pull pipelines all follow a consistent pattern for adding new resource types. The pronunciation dictionary type is unique in that it is a provider-level resource (endpoint: `/provider/{provider}/pronunciation-dictionary`) rather than a top-level Vapi resource (endpoint: `/assistant`, `/tool`), and it carries provider-specific state metadata beyond a simple UUID.

## Goals

- [ ] Primary: Enable pronunciation dictionaries to be managed as code -- created, updated, reviewed, and versioned through the gitops workflow
- [ ] Secondary: Resolve assistant dictionary references during push so the Vapi API contract is maintained without manual UUID wiring
- [ ] Secondary: Support no-op detection so unchanged dictionaries are not PATCHed on every push
- [ ] Secondary: Pull remote dictionaries into local files so the gitops repo stays in sync with the platform

## Technical Approach

### Architecture

Pronunciation dictionaries are a new resource type slotted into the existing engine at every integration point. The key architectural decisions are:

1. **New resource type `pronunciationDictionaries`** registered in `types.ts`, `resources.ts`, `config.ts`, `state.ts`, `push.ts`, `pull.ts`, `delete.ts`, `state-merge.ts`, `validate.ts`, and the various CLI modules. This follows the exact pattern used when `evals` and simulation types were added.

2. **Extended state metadata.** Unlike other resource types where state stores `{ uuid }` and the UUID is both the Vapi wrapper ID and the identity used in references, dictionaries need richer state. State entries for dictionaries include `{ uuid, providerDictId, providerVersionId, provider }`. The `uuid` is the Vapi wrapper resource ID (used for PATCH/DELETE against `/provider/{provider}/pronunciation-dictionary/{uuid}`). The `providerDictId` and `providerVersionId` are the provider-side identifiers used in assistant voice configs (e.g., 11labs `pronunciationDictionaryLocators[].pronunciationDictionaryId`). These additional fields live alongside the existing `ResourceState` fields (`lastPulledHash`, `lastPushedHash`, etc.) as optional properties.

3. **Versioned file format.** Each dictionary file contains a `versions` map and an `activeVersion` pointer. The engine resolves `activeVersion` to extract the rules payload for the active version. Change detection compares the hash of the resolved active-version payload against `lastPushedHash`.

4. **Dependency order: dictionaries before assistants.** During push, dictionaries are applied before assistants so that assistant voice config references can be resolved. This mirrors the existing tools-before-assistants ordering.

5. **Reference resolution.** A new resolver path handles dictionary references in assistant voice configs. The local file uses a `pronunciationDictionaryId: my-dict-name` pattern (local resource ID). During push, this is resolved to the provider-specific fields. During pull, the reverse mapping replaces provider IDs with local resource IDs.

6. **Provider-aware API calls.** The push and pull flows need to know which provider a dictionary belongs to in order to call the correct endpoint (`/provider/11labs/pronunciation-dictionary` vs `/provider/cartesia/pronunciation-dictionary`). The `provider` field in the local file determines this.

### Component Design

**New components:**

- `src/pronunciation-dict.ts`: Core module for pronunciation dictionary operations. Contains:
  - `applyPronunciationDictionary()` -- create or update a dictionary via the provider API
  - `pullPronunciationDictionaries()` -- fetch and materialize remote dictionaries
  - `resolveActiveVersion()` -- extract the active version's rules payload from a versioned file
  - `buildProviderPayload()` -- convert local rules format to provider-specific API body
  - `buildProviderEndpoint()` -- construct the correct `/provider/{provider}/pronunciation-dictionary` path
  - Provider-specific helpers for 11labs vs Cartesia rule format conversion

**Modified components:**

- `src/types.ts`: Add `"pronunciationDictionaries"` to `ResourceType` union. Add `pronunciationDictionaries` section to `StateFile`, `LoadedResources`. Extend `ResourceState` with optional `providerDictId`, `providerVersionId`, `provider` fields.
- `src/resources.ts`: Add `pronunciationDictionaries: "pronunciationDictionaries"` to `FOLDER_MAP`.
- `src/config.ts`: Add `pronunciationDictionaries` to `UPDATE_EXCLUDED_KEYS`.
- `src/state.ts`: Add `pronunciationDictionaries` to `createEmptyState()` and `loadState()` migration.
- `src/state-merge.ts`: Add `pronunciationDictionaries` to `SECTIONS` array and `TouchedSets` interface.
- `src/push.ts`: Add pronunciation dictionary loading, apply phase (before assistants), reference resolution for assistant voice configs, and state tracking. Add to `RESOURCE_LABEL_TO_TYPE`, `ALL_RESOURCE_TYPES`, `TouchedSets`, orphan detection, summary output.
- `src/pull.ts`: Add `ENDPOINT_MAP` entry (provider-specific fetch), `pullPronunciationDictionaries()` call in `runPull()`, reverse reference resolution for assistant voice configs.
- `src/delete.ts`: Add `pronunciationDictionaries` to `DELETE_ENDPOINT_MAP` (provider-aware), orphan detection.
- `src/cleanup.ts`: Add pronunciation dictionaries to resource type list for cleanup scan.
- `src/resolver.ts`: Add `resolvePronunciationDictRefs()` for assistant voice config dictionary references. Add reverse resolution in `resolveReferencesToResourceIds()`.
- `src/validate.ts`: Add validation for dictionary file shape (valid provider, activeVersion exists in versions map, rules are well-formed).
- `src/new-file-gate.ts`: Already generic over `VALID_RESOURCE_TYPES`; no changes needed beyond the type registration.
- `src/recanonicalize.ts`, `src/reconcile-state-key.ts`, `src/dep-dedup.ts`, `src/snapshot.ts`, `src/audit.ts`: These modules iterate over resource types from `VALID_RESOURCE_TYPES` or `StateFile` keys and will automatically pick up the new type once registered. Minor updates may be needed if they have hardcoded type lists.

### API Changes

**Provider API endpoints used (existing Vapi API, not modified):**

- `POST /provider/{provider}/pronunciation-dictionary` -- Create a new dictionary
- `PATCH /provider/{provider}/pronunciation-dictionary/{uuid}` -- Update dictionary rules
- `GET /provider/{provider}/pronunciation-dictionary` -- List all dictionaries
- `GET /provider/{provider}/pronunciation-dictionary/{uuid}` -- Get single dictionary
- `DELETE /provider/{provider}/pronunciation-dictionary/{uuid}` -- Delete a dictionary

**No Vapi API changes.** The gitops engine calls these existing endpoints. The provider is `11labs` or `cartesia`, determined by the `provider` field in the local dictionary file.

**Backward compatibility:** Yes. The new resource type is additive. Existing state files without `pronunciationDictionaries` will get an empty section on load (the `createEmptyState()` spread pattern handles this). Existing assistant files that use hardcoded UUIDs in `pronunciationDictionaryLocators` or `pronunciationDictId` continue to work unchanged -- the reference resolver only activates for non-UUID values.

### Database Changes

No database changes. State is file-based (`.vapi-state.<env>.json`).

**State file schema extension:**

```json
{
  "pronunciationDictionaries": {
    "my-custom-dict": {
      "uuid": "vapi-wrapper-uuid",
      "providerDictId": "11labs-or-cartesia-dict-id",
      "providerVersionId": "11labs-version-id-or-null",
      "provider": "11labs",
      "lastPulledHash": "sha256...",
      "lastPushedHash": "sha256...",
      "lastPulledAt": "2026-05-15T00:00:00.000Z"
    }
  }
}
```

**Migration strategy:** Backward-compatible. `loadState()` already spreads `createEmptyState()` over the loaded JSON, so missing keys default to `{}`. The extended `ResourceState` fields (`providerDictId`, `providerVersionId`, `provider`) are optional and only populated for pronunciation dictionary entries.

## Implementation Steps

### Step 1: Register the New Resource Type

**Files:**

- Modify: `src/types.ts`, `src/resources.ts`, `src/config.ts`, `src/state.ts`, `src/state-merge.ts`

**Description:**

Add `"pronunciationDictionaries"` to all type registrations:

1. In `src/types.ts`:
   - Add `"pronunciationDictionaries"` to the `ResourceType` union type
   - Add `pronunciationDictionaries` to `VALID_RESOURCE_TYPES` array (insert before `"evals"` to maintain dependency order)
   - Add `pronunciationDictionaries: Record<string, ResourceState>` to `StateFile` interface
   - Add `pronunciationDictionaries: ResourceFile<Record<string, unknown>>[]` to `LoadedResources` interface
   - Extend `ResourceState` with optional fields: `providerDictId?: string`, `providerVersionId?: string`, `provider?: string`

2. In `src/resources.ts`:
   - Add `pronunciationDictionaries: "pronunciationDictionaries"` to `FOLDER_MAP`

3. In `src/config.ts`:
   - Add `pronunciationDictionaries: ["type"]` to `UPDATE_EXCLUDED_KEYS` (the `type` field is server-managed for provider resources)

4. In `src/state.ts`:
   - Add `pronunciationDictionaries: {}` to `createEmptyState()`
   - Add `pronunciationDictionaries: migrateSection(merged.pronunciationDictionaries as Record<string, unknown>)` to `loadState()`

5. In `src/state-merge.ts`:
   - Add `"pronunciationDictionaries"` to `SECTIONS` array
   - Add `pronunciationDictionaries: Set<string>` to `TouchedSets` interface

**Testing:**
- Build passes (`npm run build`)
- Existing tests still pass (`npm run test`)
- State file loads correctly with and without the new section

**Dependencies:** None

### Step 2: Create the Pronunciation Dictionary Module

**Files:**

- Create: `src/pronunciation-dict.ts`

**Description:**

Create the core module implementing all pronunciation dictionary operations.

**Key functions:**

```typescript
// Resolve the activeVersion from a dictionary file to get the rules payload
function resolveActiveVersion(data: PronunciationDictFile): {
  versionKey: string;
  rules: PronunciationRule[];
}

// Build the provider-specific API endpoint
function buildProviderEndpoint(provider: string, uuid?: string): string
// e.g., "/provider/11labs/pronunciation-dictionary" or "/provider/11labs/pronunciation-dictionary/{uuid}"

// Build the provider-specific create/update payload from local rules
function buildCreatePayload(data: PronunciationDictFile): Record<string, unknown>
function buildUpdatePayload(data: PronunciationDictFile): Record<string, unknown>

// Apply (create or update) a single dictionary
async function applyPronunciationDictionary(
  resource: ResourceFile,
  state: StateFile,
): Promise<{ uuid: string; providerDictId: string; providerVersionId?: string } | null>

// Fetch all remote dictionaries for a given provider
async function fetchProviderDictionaries(provider: string): Promise<VapiResource[]>

// Determine if the active version content has changed (no-op detection)
function hasActiveVersionChanged(
  data: PronunciationDictFile,
  state: ResourceState,
): boolean
```

**Local file type definition:**

```typescript
interface PronunciationRule {
  type: "alias" | "phoneme";
  stringToReplace: string;
  alias?: string;
  phoneme?: string;
  alphabet?: "ipa" | "cmu-arpabet";
  caseSensitive?: boolean;
  wordBoundaries?: boolean;
}

interface CartesiaRule {
  text: string;
  alias: string;
}

interface PronunciationDictVersion {
  rules: PronunciationRule[] | CartesiaRule[];
}

interface PronunciationDictFile {
  provider: "11labs" | "cartesia";
  name: string;
  activeVersion: string;
  versions: Record<string, PronunciationDictVersion>;
}
```

**No-op detection:** On update, resolve the active version's rules, hash them with `hashPayload()`, and compare against `state.lastPushedHash`. If they match, skip the PATCH. This ensures unchanged dictionaries are not re-pushed.

**Create vs Update logic:**
- If no `uuid` in state: POST to create, extract `uuid`, `providerDictId`, and `providerVersionId` from response.
- If `uuid` exists in state AND active version changed: PATCH with the new rules payload.
- If `uuid` exists AND active version unchanged: no-op, log skip.

**Provider-specific payload building:**
- **11labs**: `{ name, rules: [...] }` for create; `{ rules: [...] }` for update (PATCH only accepts `rules` -- validated by the API: "Only rules can be updated for a pronunciation dictionary")
- **Cartesia**: `{ name, items: [...] }` for create; `{ items: [...] }` for update

**Testing:**
- Unit tests for `resolveActiveVersion()`, `hasActiveVersionChanged()`, `buildCreatePayload()`, `buildUpdatePayload()`
- Test that missing activeVersion in versions map throws a clear error
- Test no-op detection when hash matches

**Dependencies:** Step 1

### Step 3: Integrate Push Flow

**Files:**

- Modify: `src/push.ts`

**Description:**

Wire pronunciation dictionaries into the push pipeline:

1. Add to `RESOURCE_LABEL_TO_TYPE`: `"pronunciation dictionary": "pronunciationDictionaries"`

2. Add to `ALL_RESOURCE_TYPES`: `"pronunciationDictionaries"`

3. Add to `emptyTouchedSets()`: `pronunciationDictionaries: new Set()`

4. Load pronunciation dictionaries alongside other resources:
   ```typescript
   const allPronunciationDictsRaw = await loadResources<Record<string, unknown>>(
     "pronunciationDictionaries", loadOpts
   );
   ```

5. Add to `LoadedResources` construction and credential resolution.

6. Apply dictionaries BEFORE assistants (after tools and structured outputs) to ensure provider IDs are in state when assistant voice configs are resolved:
   ```typescript
   if (pronunciationDicts.length > 0) {
     console.log("\n📖 Applying pronunciation dictionaries...\n");
     for (const dict of pronunciationDicts) {
       const result = await applyPronunciationDictionary(dict, state);
       if (!result) continue;
       upsertState(state.pronunciationDictionaries, dict.resourceId, {
         uuid: result.uuid,
         providerDictId: result.providerDictId,
         providerVersionId: result.providerVersionId,
         provider: (dict.data as { provider: string }).provider,
         lastPushedHash: hashPayload(resolveActiveVersion(dict.data).rules),
       });
       touched.pronunciationDictionaries.add(dict.resourceId);
       applied.pronunciationDictionaries++;
     }
   }
   ```

7. Add to orphan deletion checks, partial apply filtering, summary output.

8. Add to `typesToDelete` logic for partial applies.

**Testing:**
- Dry-run push with a dictionary file shows "would POST" on first run, "would PATCH" on active version change, and no-op on unchanged
- Build passes

**Dependencies:** Steps 1, 2

### Step 4: Implement Assistant Dictionary Reference Resolution

**Files:**

- Modify: `src/resolver.ts`, `src/push.ts`

**Description:**

Add bidirectional reference resolution for pronunciation dictionary IDs in assistant voice configs.

**Push direction (local ID -> provider IDs):**

In `src/resolver.ts`, extend `resolveReferences()` to handle:

1. **11labs assistants:** If `voice.pronunciationDictionaryLocators` contains entries where `pronunciationDictionaryId` is a non-UUID string (local resource ID), look up the state entry and replace with `{ pronunciationDictionaryId: state.providerDictId, versionId: state.providerVersionId }`.

2. **Cartesia assistants:** If `voice.pronunciationDictId` is a non-UUID string (local resource ID), look up the state entry and replace with `state.providerDictId`.

3. **Vapi built-in voices:** If `voice.pronunciationDictionary` contains entries where `pronunciationDictId` is a non-UUID string, resolve similarly.

In `src/resolver.ts`, extend `extractReferencedIds()` to return a new `pronunciationDictionaries: string[]` field so auto-dependency resolution and the reference-to-ignored validator can see dictionary refs.

**Pull direction (provider IDs -> local IDs):**

In `src/pull.ts`, extend `resolveReferencesToResourceIds()` to reverse-map provider dictionary IDs back to local resource IDs using a reverse map built from `state.pronunciationDictionaries` entries' `providerDictId` and `providerVersionId`.

**Testing:**
- Unit test: assistant with `pronunciationDictionaryLocators: [{ pronunciationDictionaryId: "my-dict" }]` resolves to provider IDs from state
- Unit test: assistant with `pronunciationDictId: "my-dict"` resolves to provider ID from state
- Unit test: assistant with UUID values passes through unchanged
- Build passes

**Dependencies:** Steps 1, 2, 3

### Step 5: Implement Pull Flow

**Files:**

- Modify: `src/pull.ts`

**Description:**

Add pronunciation dictionary pulling:

1. **Fetching:** Unlike other resource types that have a single `GET /resource-type` endpoint, dictionaries are provider-scoped. Pull needs to fetch from BOTH providers and merge:
   - `GET /provider/11labs/pronunciation-dictionary`
   - `GET /provider/cartesia/pronunciation-dictionary`

   Handle 404 or empty responses gracefully (org may not use both providers).

2. **Materialization:** For each remote dictionary, construct the local file format:
   - The remote response contains `name`, `rules` (or `items` for Cartesia), and provider metadata.
   - Create a single-version file with `activeVersion: v1` and the rules under `versions.v1`. Users who want multiple versions can add them manually.
   - Set `provider` from the fetch source.

3. **State tracking:** Store `uuid` (the Vapi wrapper ID from the response's `id` field), `providerDictId` (the provider-side dictionary ID from the response), `providerVersionId` (from response, if present), and `provider`.

4. **Integration:** Add the pull call in `runPull()` between credentials and tools (dictionaries should be pulled before assistants so reverse reference resolution has their state available).

5. **Write format:** Write as `.yml` files to `resources/<org>/pronunciationDictionaries/`.

6. **ENDPOINT_MAP extension:** Since dictionaries use provider-specific endpoints, the pull flow will not use `ENDPOINT_MAP` directly but call the new `fetchProviderDictionaries()` helper from `pronunciation-dict.ts`.

**Testing:**
- Pull with existing remote dictionaries creates local files
- Pull with no remote dictionaries is a clean no-op
- State is populated with providerDictId and providerVersionId
- Build passes

**Dependencies:** Steps 1, 2

### Step 6: Implement Deletion and Cleanup

**Files:**

- Modify: `src/delete.ts`, `src/cleanup.ts`

**Description:**

1. In `src/delete.ts`:
   - Add `pronunciationDictionaries` to `DELETE_ENDPOINT_MAP`. Unlike other types that have a static endpoint, dictionary deletion requires the provider from state: `/provider/{provider}/pronunciation-dictionary/{uuid}`. Implement a provider-aware delete path that reads the `provider` field from the state entry.
   - Add `"pronunciation dictionary"` to `REFERENCEABLE_TYPE_MAP` as `null` (dictionaries are not referenced by other resources in a way that would block deletion -- they are referenced BY assistants, but deleting a dictionary should not be blocked by assistant references, per the requirement that "removing an assistant attachment must not delete the dictionary").

2. In `src/cleanup.ts`:
   - Add pronunciation dictionaries to the resource type scan list. Since cleanup iterates provider-specific endpoints, add both 11labs and cartesia fetches.

3. **Key requirement:** "Removing an assistant attachment must not delete the dictionary." This is naturally satisfied because:
   - Dictionary deletion is controlled by deleting the dictionary resource file OR running cleanup.
   - The orphan detection in `push.ts` only deletes resources tracked in state that have no matching local file. Removing a dictionary reference from an assistant does not remove the dictionary's local file.
   - The `findReferencingResources` check in `delete.ts` does not block dictionary deletion based on assistant references (per `REFERENCEABLE_TYPE_MAP` setting).

**Testing:**
- Deleting a local dictionary file + push with --force removes the dictionary from the provider
- Removing a dictionary reference from an assistant does NOT delete the dictionary
- Cleanup scan finds orphaned dictionaries

**Dependencies:** Steps 1, 2, 3

### Step 7: Add Validation

**Files:**

- Modify: `src/validate.ts`

**Description:**

Add client-side validation checks for pronunciation dictionary files:

1. **Shape validation:** Verify the file has required fields: `provider` (must be `"11labs"` or `"cartesia"`), `name` (string), `activeVersion` (string), `versions` (object).

2. **Active version existence:** Verify `activeVersion` points to a key that exists in `versions`.

3. **Rules validation per provider:**
   - 11labs: each rule must have `type` (`"alias"` or `"phoneme"`), `stringToReplace`, and either `alias` (for type alias) or `phoneme` + `alphabet` (for type phoneme).
   - Cartesia: each item must have `text` and `alias`.

4. **Cross-resource validation:** Warn when an assistant references a dictionary resource ID that does not exist in the loaded dictionary set.

5. Add `pronunciationDictionaries` to `RESOURCE_TYPES_WITH_REFS` if dictionaries reference other resources (they do not, so this is only needed for the reverse check in `validateNoIgnoredReferences`).

**Testing:**
- Validation catches missing activeVersion
- Validation catches invalid provider
- Validation catches malformed rules
- Build passes

**Dependencies:** Step 1

### Step 8: Add Tests

**Files:**

- Create: `tests/pronunciation-dict.test.ts`

**Description:**

Comprehensive test suite covering:

1. **resolveActiveVersion:** correct version extraction, error on missing version
2. **buildCreatePayload / buildUpdatePayload:** correct provider-specific payload for 11labs and Cartesia
3. **hasActiveVersionChanged:** true when rules differ, false when hash matches
4. **Reference resolution:** assistant voice config dictionary refs resolve to provider IDs
5. **Reverse resolution:** provider IDs in pulled assistant configs resolve back to local IDs
6. **Validation:** shape checks, activeVersion existence, rule format per provider
7. **State migration:** existing state files without `pronunciationDictionaries` section load cleanly
8. **No-op detection:** push skips PATCH when active version hash is unchanged

Use the Node.js built-in test runner (`node:test`) and `node:assert` per the existing test conventions.

**Testing:** All new tests pass, all existing tests still pass.

**Dependencies:** Steps 1-7

### Step 9: Update Documentation and Wiring

**Files:**

- Modify: `src/audit.ts`, `src/recanonicalize.ts`, `src/reconcile-state-key.ts`, `src/snapshot.ts`, `src/new-file-gate.ts`

**Description:**

Ensure all modules that iterate over resource types properly handle the new type. Most of these modules use `VALID_RESOURCE_TYPES` from `types.ts` and will automatically pick up the new type, but verify and update any hardcoded type lists:

1. `src/audit.ts`: If it has hardcoded resource type lists, add `pronunciationDictionaries`.
2. `src/recanonicalize.ts`: Uses `StateFile` keys -- will pick up automatically.
3. `src/reconcile-state-key.ts`: Uses `ResourceType` -- will pick up automatically.
4. `src/snapshot.ts`: If snapshot logic iterates types, add `pronunciationDictionaries`.
5. `src/new-file-gate.ts`: Uses `VALID_RESOURCE_TYPES` -- will pick up automatically.

**Testing:**
- Full build passes
- Full test suite passes
- `npm run validate -- <org>` runs without error with dictionary files present

**Dependencies:** Steps 1-8

## Testing Strategy

**Unit tests (in `tests/pronunciation-dict.test.ts`):**
- Active version resolution (happy path and error cases)
- Payload building for both 11labs and Cartesia
- No-op detection via hash comparison
- Reference resolution in both directions
- Validation rule checks
- State migration backward compatibility

**Integration tests (manual, against a Vapi test org):**
- Create a dictionary from a local file and verify it exists on the provider
- Change `activeVersion` content and push -- verify PATCH fires
- Push unchanged dictionary -- verify no PATCH (dry-run confirms no-op)
- Pull remote dictionaries -- verify local files are created correctly
- Delete local dictionary file + `--force` push -- verify provider deletion
- Remove dictionary reference from assistant -- verify dictionary is NOT deleted
- Reference resolution: assistant with local dictionary ID pushes correctly

**Edge cases:**
- Dictionary file with `activeVersion` pointing to non-existent version key
- Dictionary file with empty rules array
- Dictionary file missing required fields
- State file without `pronunciationDictionaries` section (backward compat)
- Pull when org has dictionaries from only one provider
- Pull when org has no dictionaries at all
- Dictionary referenced by multiple assistants
- Two dictionaries from different providers with the same name

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Vapi provider API response schema differs from documentation | Medium | Medium | Defensive parsing with explicit error messages. Log full response on unexpected shapes. Build integration tests against a real org early. |
| PATCH strict validation ("Only rules can be updated") causes failures | Medium | Low | Separate create and update payloads. Update sends only the `rules` (11labs) or `items` (Cartesia) field. Confirmed in existing learnings docs. |
| State migration breaks existing state files | Low | High | The `createEmptyState()` spread pattern already handles missing keys. Extended `ResourceState` fields are all optional. Verified by examining existing migration code. |
| Provider-specific endpoints complicate the generic resource pattern | High | Low | Accept the complexity. Create a dedicated `pronunciation-dict.ts` module rather than force-fitting into the generic `vapiRequest` path. The provider endpoint pattern is a known divergence. |
| Assistant reference resolution misses edge cases (Vapi built-in voices, squad memberOverrides) | Medium | Medium | Comprehensive resolver coverage for all three voice config shapes. Validation warns when references cannot be resolved. |
| Pronunciation dictionary deletion cascades to assistants | Low | High | Explicitly NOT blocking deletion on assistant references. The requirement states deletion is controlled by file deletion, not by detaching from assistants. Document this in learnings. |

## Dependencies

**External services:**
- Vapi API: `/provider/{provider}/pronunciation-dictionary` endpoints for CRUD operations
- ElevenLabs provider (via Vapi): Dictionary creation and management
- Cartesia provider (via Vapi): Dictionary creation and management

**Internal prerequisites:**
- None. All changes are additive to the existing codebase.

## Complexity

**Assessment: Complex**

Reasoning:
- Total files: 2 created + 12 modified = 14 files (exceeds 10-file threshold)
- New API integration with provider-specific endpoints (not a standard Vapi top-level resource)
- Extended state metadata beyond the standard `ResourceState` shape
- Bidirectional reference resolution across voice config fields
- Two distinct provider formats (11labs rules vs Cartesia items)
- 9 implementation steps

## Success Criteria

- [ ] A pronunciation dictionary can be created from a local YAML file via `npm run push`
- [ ] Updating `activeVersion` content triggers a provider PATCH on push
- [ ] No-op pushes do not PATCH unchanged dictionaries (verified via `--dry-run`)
- [ ] Assistant `pronunciationDictionaryLocators` and `pronunciationDictId` references to local dictionary IDs resolve correctly during push
- [ ] `npm run pull` creates or updates local dictionary files from provider state
- [ ] Removing a dictionary reference from an assistant does not delete the dictionary
- [ ] Dictionary deletion is controlled by deleting the dictionary resource file + `--force` push
- [ ] State tracks Vapi wrapper UUID, provider dictionary ID, provider version ID, and provider name
- [ ] Existing state files without `pronunciationDictionaries` load without error
- [ ] `npm run build` passes (TypeScript compiles cleanly)
- [ ] `npm run test` passes (all existing + new tests green)
- [ ] Validation catches malformed dictionary files before any API call
