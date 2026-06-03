# Vapi GitOps — Engine Improvements Log

> **MAINTENANCE DIRECTIVE FOR CONTRIBUTORS (humans and AI agents):**
> This file is the running log of friction, footguns, and improvement ideas
> for the gitops engine in this template repo. It is the upstream source of
> truth — every customer fork inherits it on clone, and every customer log
> entry that surfaces an upstream-relevant gap eventually lands here.
>
> **When you discover ANY of the following, add an entry to this file in the
> same change:**
> - A push/pull/apply behavior that surprises a user or causes data loss
> - A footgun in `src/*.ts` that isn't documented in `AGENTS.md` or `docs/learnings/`
> - A missing safety rail (no drift detection, no dry-run, no rollback, etc.)
> - A coordination problem (concurrent edits, dashboard-vs-local divergence)
> - A workflow-level recommendation that emerged from real customer work
>
> **Format:** each entry uses the **Problem → Current behavior → Risk →
> Current mitigation → Possible fix → Status** structure (see "Entry
> template" below). Date the entry. Link to relevant source files / PRs
> with line references so future readers can verify your claims.
>
> **Two evidence rules keep this file trustworthy:**
> - **Verified current behavior** — confirmed in this repo (source, scripts,
>   or docs) and cited directly.
> - **Needs platform validation** — engine-side behavior verified, but the
>   corresponding Vapi platform capability is still unknown. Label any
>   platform-side claim that hasn't been confirmed.
>
> **When a fix lands**, mark the entry `[RESOLVED YYYY-MM-DD] (#<PR-number>)`
> at the top of the entry — don't delete it. The history is the point.

---

## How to read this file

Sections are ordered by **severity / blast radius**, not by date discovered.
Within each entry:

- **Problem** — one-sentence statement of what's wrong.
- **Current behavior** — what the engine actually does today, with code
  references so the next person can verify.
- **Risk** — what can go wrong in real workflows.
- **Current mitigation** — what users should do today to avoid the problem.
- **Possible fix** — sketch of an engineering change.
- **Status** — open / partially mitigated / resolved.

## Triage at a glance

**Statuses below reflect the state at the tip of each PR. Subsequent PRs in
this stack flip rows from `Open` to `RESOLVED` as they land — the cell tells
you which stack PR closes the row.**

| #   | Title                                                    | Why it matters                                     | Depends on | Status                            |
| --- | -------------------------------------------------------- | -------------------------------------------------- | ---------- | --------------------------------- |
| 1   | `push` drift detection                                   | Prevent silent overwrites of dashboard edits       | #4         | RESOLVED 2026-04-30 (Stack G)     |
| 2   | `apply` same-file conflict                               | `apply` drops concurrent same-file dashboard edits | #4         | Partial — Stack G GET on push     |
| 3   | Rollback                                                 | Current undo can clobber newer live changes        | #4, #5     | RESOLVED 2026-04-30 (Stack H)     |
| 4   | State schema content hashes                              | Architectural unlock for #1, #2, #3, #6, #7        | None       | RESOLVED 2026-04-30 (Stack F)     |
| 5   | `push --dry-run`                                         | Cheapest operator-safety win                       | None       | RESOLVED 2026-04-30 (Stack C)     |
| 6   | API-level optimistic concurrency                         | Server-side conflict rejection                     | Platform   | Deferred (Stack I, gated)         |
| 7   | Voice edits drop pronunciation-dictionary attachments    | Silent regression on Cartesia + 11labs voice edits | #4         | RESOLVED 2026-04-30 (Stack G)     |
| 8   | Dashboard prompt edits can in-place duplicate the prompt | Two stacked prompt versions = stitched output      | None       | Partial — Stack D heuristic       |
| 9   | Provider-specific voice schema mismatch (push 400)       | `voice.speed` vs `voice.generationConfig.speed`    | None       | RESOLVED 2026-04-30 (Stack D + A) |
| 10  | Targeted assistant push mints duplicate tools            | Re-pushing assistant duplicates `end-call-*` tools | #4         | RESOLVED 2026-05-06 (#23)         |
| 11  | Bidirectional SO ↔ assistant lockstep has no validation  | One-sided edits silently inconsistent              | None       | RESOLVED 2026-04-30 (Stack D)     |
| 12  | State file accumulates UUIDs without source files        | Silent gitops drift                                | None       | Partial                           |
| 13  | `.agent/` and `.claude/handoffs/` not gitignored         | `git add -A` sweeps PII handoff scratch            | None       | RESOLVED 2026-04-30 (Stack A)     |
| 14  | Multi-file push undocumented                             | Discoverability                                    | None       | RESOLVED 2026-04-30 (Stack A)     |
| 15  | Scoped push rewrites entire state file                   | Pre-existing drift sweeps into focused commits     | #4         | RESOLVED 2026-04-30 (Stack J)     |
| 16  | No CLI runner for simulation suites                      | Engine pushes them, can't run them                 | None       | RESOLVED 2026-04-30 (Stack E)     |
| 17  | State file key-order churn produces noisy diffs          | Reorderings hide real changes                      | None       | RESOLVED 2026-04-30 (Stack B)     |
| 18  | Structured-output `name` capped at 40 chars (no warning) | Push fails partway after partial application       | None       | RESOLVED 2026-04-30 (Stack D)     |
| 19  | No `maxTokens` floor warning for tool-using assistants   | `maxTokens: 1` bricks the assistant silently       | None       | RESOLVED 2026-04-30 (Stack D)     |
| 20  | Prompt vocabulary leaks into TTS                         | `Reason.` becomes verbal contaminant               | None       | Partial — Stack D heuristic       |
| 21  | `.vapi-ignore` was pull-only (push could silently delete) | `--force` push DELETEd dashboard-only opt-outs    | None       | RESOLVED 2026-05-11 (#TBD)        |

---

## 1. `push` has no drift detection — silently overwrites concurrent dashboard edits

**Discovered:** customer-fork log (Amazon3p `improvements.md` #1, 2026-04-17)

### Problem

`npm run push -- <env>` blindly `PATCH`es the local payload onto the
platform without checking whether the platform's current state matches what
we last pulled. If anyone else (a teammate, a customer, an automation)
edits the same resource on the dashboard between our last pull and our
push, their change is silently overwritten with no warning.

### Current behavior (Verified)

The push code path is a straight `PATCH /resource/{uuid}` with the full
local payload — no `If-Match` header, no version field comparison, no
fetch-then-diff. See `src/push.ts:73-79` and `src/api.ts:65-71` (no
conditional-write headers anywhere in the request path). The state file
(`.vapi-state.<env>.json`) only stores identity mappings (`name → UUID`)
— no content hashes, no version numbers, no timestamps.

### Risk

A teammate dashboard-edits a prompt during a live test; you push your
unrelated branch and their edit disappears. A customer success rep updates
business hours via the dashboard; the next gitops push silently reverts
it. A `git revert + push` rollback inherits the same problem — it
overwrites whatever's currently live, not just the change being reverted.

### Current mitigation

Use `npm run apply -- <env>` (`pull → push`) instead of bare `push`. The
`pull` step is git-aware and preserves locally-modified files while
pulling fresh state for everything else (see #2 for the residual same-file
conflict case). Bare `push` should be reserved for environments where you
know nobody else touches the dashboard.

### Possible fix

1. **Content-hash drift detection.** Store sha256 of the platform's
   last-known content per resource in `.vapi-state.<env>.json`. On push,
   GET the current platform version, hash it, refuse to push if the hash
   doesn't match — surface the diff and require an explicit
   `--overwrite` flag. Depends on #4.
2. **Server-side ETag / If-Match.** See #6.
3. **Pre-push diff (poor man's version of #1).** Run a `pull --dry-run`
   before push and show the user what's about to change — partial
   mitigation only.

### Status

**Open.** Targeted by **Stack G** (drift detection); depends on **Stack F**
(state schema). Mitigated by `apply -- <env>` for the non-same-file case.

---

## 2. `apply` (pull → push) silently drops dashboard edits to files modified locally

**Discovered:** customer-fork log (Amazon3p #2, 2026-04-17)

### Problem

`pull` uses `git status --porcelain` to identify locally-modified files
and **preserves the local version**, dropping the platform's version of
those files entirely. There's no warning that the platform's version
differs from what your local file was based on.

### Current behavior (Verified)

`src/pull.ts:117-135` (`getLocallyChangedFiles()`) and `src/pull.ts:705-735`
(the preserve-local-on-pull branch). The "preserved" message in
`src/pull.ts:887-896` tells you the count but not whether the platform's
version of that same file diverged from your branch point. There's no
3-way merge — local wins by default.

### Risk

You edit `assistants/foo.md` locally. A teammate edits the same
`assistants/foo.md` on the dashboard. You run `apply`. Pull preserves your
local version with no warning that the dashboard had a different version,
then push overwrites the dashboard with yours. Their change is lost.

### Current mitigation

Coordinate on shared resources. Always commit before pushing so git
history at least preserves your version cleanly. After any known
dashboard-side change, run `pull` first so the conflict surfaces as a
`git diff` rather than a silent overwrite.

### Possible fix

Same as #1: with content-hash drift detection (#4), `pull` could detect
the same-file conflict and either refuse to preserve (requiring
`--keep-local <file>` resolution), or write the platform's version to a
sibling `.platform.yml` for manual 3-way merge.

### Status

**Open.** Targeted by **Stack G**.

---

## 3. No rollback command — `git revert + push` inherits all of #1's problems

**Discovered:** customer-fork log (Amazon3p #3, 2026-04-17)

### Problem

The README documents the rollback strategy as `git revert + push`. That
restores local content to a previous git state, but it does **not**
restore a known platform snapshot. The subsequent push still has all the
drift problems above, so a "rollback" can clobber unrelated dashboard
edits made since the bad deploy. There is also no engine-level snapshot
of what was sent.

### Current behavior (Verified)

`package.json` has no `rollback` script. The README still documents
rollback as a git-level revert followed by a push. The platform-side
safety net is the dashboard's Version History feature (manual,
per-resource, dashboard-driven).

### Risk

Rollback is a manual two-step (`git revert <sha>` → `npm run push --
<env>`), with the same overwrite risk as any other push. If the bad push
was never committed locally, there's no clean rollback target in git.

### Current mitigation

Always `git commit` before `push -- <env>`. For mission-critical
resources, note UUIDs so dashboard Version History is reachable.

### Possible fix

**Snapshot-on-push.** Before each PATCH, write the *outgoing* payload AND
the *current platform payload* to
`.vapi-state.<env>.snapshots/<timestamp>/<resource-type>/<id>.json`. Add
`npm run rollback -- <env> --to <timestamp>`.

### Status

**Open.** Targeted by **Stack H**; depends on **Stack F**.

---

## 4. State file is identity-only — no content snapshots

**Discovered:** customer-fork log (Amazon3p #4, 2026-04-17)

### Problem

`.vapi-state.<env>.json` stores `name → UUID` mappings only. It has no
record of the content that was last pulled or pushed for each resource.
This is the architectural reason drift detection isn't possible — the
engine has no "last known platform state" to compare against.

### Current behavior (Verified)

`src/types.ts:5-16` types every section as `Record<string, string>`.
`src/state.ts:10-22` (`createEmptyState()`) and the load/save flow at
`src/state.ts:25-64` carry only identity mappings.

### Risk

Upstream cause of #1, #2, #3, #6, #7, #15. Fixing this enables the
proposed mitigations above.

### Possible fix

Extend the state schema to include content hashes (and optionally last-
pull timestamps and platform-reported version IDs):

```ts
interface ResourceState {
  uuid: string;
  lastPulledHash?: string;     // sha256 of normalized platform payload
  lastPulledAt?: string;        // ISO timestamp
  lastPushedHash?: string;      // sha256 of last pushed payload
  platformVersionId?: string;   // if Vapi exposes one
}
```

The existing `loadState()` merge with `createEmptyState()` (`src/state.ts:48-52`)
makes the additive shape backwards-compatible — legacy string-only
entries can be wrapped at load time.

### Status

**Open.** Targeted by **Stack F** — architectural prerequisite for
G, H, I, J.

---

## 5. No `push --dry-run` / pre-push diff

**Discovered:** customer-fork log (Mudflap #6 + Amazon3p #5, 2026-04-17/28)

### Problem

There's no way to preview what `push` will change on the platform before
running it. Vapi's dashboard has "Version Preview" for the same purpose;
the engine doesn't have a local equivalent.

### Current behavior (Verified)

`push.ts` has a dry-run concept only for **deletions** — `FORCE_DELETE`
default off → orphaned resources are listed but not deleted (see
`src/push.ts:842`). There is no dry-run for updates or creates.

### Risk

Users cannot validate "is this push doing what I think it's doing"
before it lands on prod. In a multi-customer repo with prod state, an
accidental wide-scope push (e.g. forgetting a file path arg) hits live
assistants. Compounds #1.

### Possible fix

Add `--dry-run` to `src/config.ts`'s `parseFlags()`. At every
`vapiRequest("PATCH"|"POST"|"DELETE", ...)` call site, gate behind
`if (!DRY_RUN)`. Print `[dry-run] would PATCH /assistant/<uuid>` instead.
Skip the state-file write entirely. End-of-run summary: `would create N,
would update M, would delete K`.

### Status

**Open.** Targeted by **Stack C** — cheapest individual fix; partially
mitigates #1, #3, #6.

---

## 6. No optimistic concurrency at the API protocol level

**Discovered:** customer-fork log (Amazon3p #6, 2026-04-17)

### Problem

Even if the engine were perfectly drift-aware locally, true race
prevention still needs help from the write API. If two clients race, the
cleanest outcome is for the server to reject stale writes rather than
letting the last writer win silently.

### Current behavior

**Verified in engine:** mutating requests in `src/api.ts:65-71` send only
auth and content-type headers. No `If-Match` / `If-Unmodified-Since`
anywhere.

**Needs platform validation:** we have not yet confirmed whether Vapi
write endpoints support ETags, `If-Match`, `If-Unmodified-Since`, or any
equivalent optimistic-concurrency mechanism. Until that is verified,
"the engine does not send conditional headers" and "the API does/does
not support them" are separate statements.

### Risk

Two simultaneous gitops pipelines (e.g. a dev pushing and a CI job
deploying) could race on the same resource with no conflict detection at
any layer.

### Current mitigation

None at the API level. The `apply` flow + git coordination is the only
defense.

### Possible fix

1. Confirm whether the API supports `If-Match` / `If-Unmodified-Since`
   on `PATCH /assistant/{id}`, `PATCH /squad/{id}`, etc.
2. If yes: extend `vapiRequest` to accept an optional ETag and have the
   apply functions in `src/push.ts` send the last-known ETag (stored in
   #4's extended state file).
3. If no: file a feature request with Vapi.

### Status

**Deferred pending platform validation (2026-04-30).** Stack I in the
sequenced plan is intentionally not landed in this branch. Implementing
`If-Match` / `ETag` on the engine side without confirming the platform
honors the headers would create dead code that gives a false sense of
safety: pushes would still succeed under races, and the conditional-header
guard would do nothing. Owner: file a feature-request ticket with the Vapi
platform team to confirm support, then ship Stack I behind a flag.

---

## 7. Voice edits drop pronunciation-dictionary attachments (Cartesia + 11labs)

**Discovered:** customer-fork log (Amazon3p #7, 2026-04-19)

### Problem

When a voice configuration changes in the Vapi dashboard, the
pronunciation-dictionary attachment can be **silently removed** from
the resource. Two shapes are affected:

- **Cartesia:** `voice.pronunciationDictId` (single string id) —
  observed dropping on voice-picker edits in the customer log.
- **11labs:** `voice.pronunciationDictionaryLocators` (array of
  `{ pronunciationDictionaryId, versionId }` objects) — the
  documented Vapi shape; the same drift class applies if a
  dashboard edit detaches an entry from the array.

The new voice is selected, but the dictionary attachment is dropped
without warning.

### Current behavior (Verified)

Confirmed for Cartesia by diffing pre/post-customer-edit pulls of the
same squad's `membersOverrides.voice` block — the `pronunciationDictId`
line vanishes on voice change. The 11labs shape is documented at
<https://docs.vapi.ai/assistants/pronunciation-dictionaries> and uses
an array; either array shrink or array clear is the equivalent drift.
Note Cartesia's single-id form is **not** in the Vapi docs but is
accepted as a passthrough to Cartesia's native API.

### Risk

Acronym/brand pronunciation regresses wherever the dictionary was the
only source of truth. Customers compensate by stuffing inline
pronunciation rules into prompts, which is strictly worse. Drift is
invisible until you actually listen to the agent.

### Current mitigation

After any known voice change, immediately verify that the dictionary
attachment is still set:

- Cartesia: `voice.pronunciationDictId` still present.
- 11labs: `voice.pronunciationDictionaryLocators` still has the
  expected entries.

Treat the dictionary attachment as part of the voice's identity during
edits. See `docs/learnings/voice-providers.md`.

### Possible fix

1. **Pull-side warning.** When `pull` materialises a `voice` block that
   loses a previously-tracked dictionary attachment (either the
   Cartesia `pronunciationDictId` or shrinkage in the 11labs
   `pronunciationDictionaryLocators` array), log a warning so the
   removal isn't invisible in the diff. Doesn't need #4.
2. **Push-side warning.** When `push` detects that local has a
   dictionary attachment but platform doesn't, surface a warning
   before applying. Needs #4 + drift detection.
3. **Vapi dashboard fix.** File a feature request to preserve
   dictionary attachments across voice changes (when the new voice
   supports it), or warn the user explicitly.

### Status

**Open.** Targeted by **Stack G** as a provider-aware drift-detection
warning covering both shapes.

---

## 8. Dashboard prompt edits can in-place duplicate the existing prompt

**Discovered:** customer-fork log (Amazon3p #8, 2026-04-19)

### Problem

When a user edits a long prompt in the Vapi dashboard, it's easy to paste
a new version on top of the existing one without first selecting and
removing the old text. The result: the saved prompt contains BOTH the
old and new versions stacked, with internally contradictory instructions.
The agent then follows both sets of rules and produces stitched-together
/ repeating output.

### Current behavior (Verified)

The dashboard accepts the duplicated prompt without complaint. The
gitops repo only surfaces the issue on the next pull, where the file
silently grows 2-5x.

### Risk

Silent prompt corruption. Hard to diagnose from runtime symptoms alone.
Affects gitops-and-dashboard-concurrent customers most acutely.

### Current mitigation

After any customer-side prompt edit, run `pull -- <env>` and inspect
prompt sizes. A sudden 2-5x size jump is almost always a paste-on-top
duplication or an intentional rewrite that needs review.

### Possible fix

1. **Engine-level lint.** `npm run validate -- <env>` heuristics:
   - Same opening header (`You are the ...` or any `# H1`) appearing twice
     in one prompt
   - Two `CONTINUITY ON ENTRY` blocks
   - Same line repeated 3+ times consecutively
   - Tool references in the prompt that aren't in `model.toolIds` or
     `tools:append`
2. **Vapi dashboard fix.** Diff/preview view in the dashboard prompt
   editor that highlights apparent duplicate blocks before save.

### Status

**Open.** Targeted by **Stack D** (heuristic lint; engine intervention
is partial — duplicated prompts can also be authored deliberately).

---

## 9. Provider-specific voice fields nest differently — schema mismatch only surfaces at push time

**Discovered:** customer-fork log (Amazon3p #9, 2026-04-19)

### Problem

Vapi's voice config schema is **provider-specific**. For 11labs,
`voice.speed` is the correct path. For Cartesia, speed lives at
`voice.generationConfig.speed`. Same field name, different nesting. The
gitops engine has no schema awareness — it accepts whatever you write,
posts to Vapi, and only the API rejection at push time tells you the
field is in the wrong place.

### Current behavior (Verified)

Observed: `voice.speed` on a Cartesia voice → `400: property speed
should not exist`. `voice.enableSsmlParsing: true` on Cartesia → same
400. The error is informative but doesn't say where the field _should_
exist or whether it exists at all for that provider.

### Risk

Push fails after the change is fully prepped. Easy to misread "rejected"
as "tool unavailable" rather than "wrong path." Provider switches break
silently in the inverse direction.

### Current mitigation

After any voice-related edit, push to a non-prod environment first if
available, OR consult `docs/learnings/voice-providers.md` (added in
**Stack A**) for the per-provider field layout.

### Possible fix

1. **Engine-level validator.** `npm run validate -- <env>` rejects:
   - Cartesia: `voice.speed`, `voice.enableSsmlParsing`,
     `voice.stability`, `voice.similarityBoost` at top level (point at
     `generationConfig.*` instead).
   - 11labs: `voice.generationConfig.*` (point at top level).
2. **Vapi side: clearer error message.** API responds with `property
   speed should not exist at this path; for cartesia use
   voice.generationConfig.speed`.

### Status

**Open.** Targeted by **Stack D** validator + the per-provider
cheat-sheet in `docs/learnings/voice-providers.md` (Stack A).

---

## 10. Targeted assistant pushes can auto-create duplicate tool dependencies

**[RESOLVED 2026-05-06] (#23)** — `ensureToolExists` /
`ensureStructuredOutputExists` now run a name-based dedup check (state-side
via `extractBaseSlug` + dashboard-side via lazy `/tool` list) between the
exact-key short-circuit and the create path. Adoption re-keys state to the
canonical UUID, drops stale duplicate state keys (orphan-deletion guard),
and routes through `applyTool` for the standard PATCH + drift-check flow.

**Discovered:** customer-fork log (Amazon3p #10, 2026-04-29)

### Problem

Repeated targeted pushes of one assistant can auto-apply local tool
dependencies and mint new duplicate tool resources instead of reusing
the already-created dependency. Repeatedly pushing one assistant
file created multiple `end-call-*` tools while refreshing only the
assistant voice config.

### Current behavior (Partially mitigated)

`src/push.ts:697-723` (`ensureToolExists()`) skips when the tool's
`toolId` is already a UUID, already exists as an exact key in
`state.tools`, or was auto-applied earlier in the same process. But the
state can lose the stable local key for a tool across bootstrap /
name-mismatch refreshes; the resolver then treats the same local
dependency as missing and creates a new dashboard tool.

### Risk

Dashboard clutter and state churn. The wrong dependency can become live —
the assistant may point at the newest duplicate while older ones remain
in state, making cleanup risky.

### Current mitigation

Before re-pushing an assistant with local tool dependencies, inspect
`.vapi-state.<env>.json` for duplicate aliases and run
`npm run cleanup -- <org>` as a dry-run.

### Possible fix

1. **Resolve dependencies by stable identity before create.**
   `ensureToolExists()` should detect when a local tool payload already
   corresponds to an existing dashboard resource under a renamed /
   state-only key and re-key state instead of creating.
2. **Duplicate-name guard for auto-applied dependencies.** Before
   `applyTool()` creates from dependency resolution, query existing
   remote tools by name / function signature and warn or reuse if
   equivalent exists.
3. **Dry-run output for targeted pushes** (Stack C).

### Status

**Resolved 2026-05-06 (#23).** Name-based dedup check (state-side +
dashboard-side) added between the exact-key short-circuit and the create
path. Adoption re-keys state to the canonical UUID, removes stale duplicate
state keys (touched-marked so `mergeScoped` flushes the deletion), and
routes through `applyTool` so a PATCH + drift check fires with the local
payload (no fake `lastPushedHash` recorded). Dashboard-side dedup honors
dry-run by skipping the API call. Prior partial mitigation
(`ensureToolExists` exact-key check) remains as the fast path; the new
dedup is the second layer for the bootstrap-renamed case.

---

## 11. Bidirectional SO ↔ assistant attachment has no validation

**Discovered:** customer-fork log (Mudflap #3, 2026-04-28)

### Problem

A structured output's `assistant_ids:` list and each assistant's
`structuredOutputIds:` list are independent declarations of the same
edge. A one-sided edit looks fine locally but produces inconsistent
dashboard state depending on which side `push` reconciles from. Lockstep
rules become memory-only conventions, not engine-enforced invariants.

### Current behavior (Verified)

The push pipeline's `updateStructuredOutputAssistantRefs()`
(`src/push.ts:574-606`) and `updateToolAssistantRefs()` independently
PATCH each side based on whichever local file was authored — never
cross-checking that both sides agree.

### Risk

Inconsistent dashboard state. Hard to audit visually because you have to
grep both files to detect drift.

### Current mitigation

Manual: grep both files when editing one side. Easy to miss.

### Possible fix

`npm run validate -- <env>`:
- For every SO file's `assistant_ids:`, check the named assistant's
  `structuredOutputIds:` lists this SO. If not, flag.
- For every assistant's `structuredOutputIds:`, check the named SO's
  `assistant_ids:` lists this assistant. If not, flag.
- Optional `--fix` to auto-mirror.

### Status

**Open.** Targeted by **Stack D**.

---

## 12. State file accumulates UUIDs without source files (silent drift)

**Discovered:** customer-fork log (Mudflap #2, 2026-04-28)

### Problem

The state file claims live resources whose specs aren't in the repo. New
engineers cloning the repo see state references to phantom resources.
Lockstep guarantees ("source matches dashboard") quietly break.

### Current behavior (Partial)

`src/push.ts:167-231` (`getInvalidStateMappings()`) detects
`missing_remote` and `name_mismatch` cases at push time and triggers a
bootstrap pull, but it doesn't catch "state has UUID, no local source
file." The pull side handles deleted-local-file as an intentional
delete tracked in state (`src/pull.ts:776-790`), which is the inverse
direction — that case is by design.

### Risk

Silent gitops drift. Phantom resources accumulate across sessions.

### Current mitigation

Periodic `npm run cleanup -- <org>` to surface orphans on the dashboard
side. No equivalent for state-side orphans.

### Possible fix

At start of `push` and end of `pull`, run a reconciliation pass:
- For every UUID in state, check that a matching source file exists at
  the expected path. If not, warn:
  `state has UUID for X but no source file at <path> — either run pull
  or remove from state`.
- For every source file, check the state has a UUID entry. If not,
  warn: `source file Y exists but state has no UUID — will create new
  on push`.

Make these warnings non-blocking but very visible.

### Status

**Partial.** `getInvalidStateMappings()` covers two of the three cases;
state-orphans-without-source remain.

---

## 13. `.agent/` and `.claude/handoffs/` are not gitignored

**[RESOLVED 2026-04-30] (Stack A)**

**Discovered:** customer-fork log (Mudflap #4, 2026-04-28)

### Problem

`.agent/` and `.claude/handoffs/` showed up in `git status` from session
start. The repo's `.gitignore` did not cover handoff-scratch directories
written by Claude Code's SessionStart hook and the new-thread skill.

### Risk

`git add -A` (or `gt modify -cam`, which uses it internally) silently
sweeps these dirs into commits. Handoff files contain conversation
snapshots, sometimes including draft messages with PII or in-progress
decisions.

### Resolution

`.gitignore` extended with `.agent/`, `.agent/handoffs/`,
`.claude/handoffs/` (the existing `.claude/` line covered the latter
already, but Mudflap's log explicitly called out `.agent/` which was
uncovered). Removed the legacy `requested improvements.md` line — that
was a per-engineer convention superseded by adopting upstream
`improvements.md`.

---

## 14. Multi-file push works but is undocumented

**[RESOLVED 2026-04-30] (Stack A)**

**Discovered:** customer-fork log (Mudflap #5, 2026-04-28)

### Problem

`AGENTS.md` documented `npm run push -- <org> <single-path>` for scoped
pushes. Multi-file (`<path1> <path2>`) worked but was undiscoverable —
engineers fell back to "push the whole org" (wider blast radius) or
sequential single-file pushes (multiple state file rewrites = more diff
noise).

### Resolution

`AGENTS.md` Quick Reference table + Available Commands block now
document multi-file push. Verified intentional in `src/config.ts:104-184`
(file-path arg detection accumulates into `filePaths[]`).

---

## 15. Scoped push still rewrites the entire state file

**Discovered:** customer-fork log (Mudflap #7, 2026-04-28)

### Problem

A surgical push of just two files rewrote the entire
`.vapi-state.<env>.json`, sweeping in pre-existing drift from earlier
pushes. The resulting commit-able state file diff was much larger than
the actual push scope warranted.

### Current behavior (Verified)

`src/push.ts:1278-1280` calls `saveState(state)` with the full state
object after every push, regardless of which paths were targeted.

### Risk

Even a focused push produces a noisy state diff that may include
unintended pre-existing dashboard drift. Reviewers can't tell "what did
this push do" from the state file diff alone.

### Possible fix

When push is scoped, only update state entries for resources actually
touched. Track touched IDs during apply; at end-of-push, merge
(load existing state → replace only touched keys → save). Needs #4 to
distinguish "stale" from "just-not-touched."

### Status

**Open.** Targeted by **Stack J**; depends on **Stack F**.

---

## 16. No CLI runner for simulation suites (despite engine tracking them)

**Discovered:** customer-fork log (Mudflap #8, 2026-04-28)

### Problem

The engine fully tracks simulation suites in state (and AGENTS.md
describes `simulations/suites/` as a first-class resource type), but
there is no `npm run` command to actually *execute* a suite. `npm run
eval` runs the legacy `/evals` endpoint, not the unified simulation
runner (`POST /eval/simulation/run`). The engine drops you at the API
doorstep when you actually want to run it.

### Current behavior (Verified)

`package.json` has `eval` (legacy) but no `sim`. `src/push.ts`'s
`applySimulationSuite()` (line 491) creates and updates suites but the
engine has no run path.

### Risk

Asymmetric tooling — engineers will go straight to the dashboard UI to
trigger runs (losing reproducibility) or write per-customer shell
wrappers. The naming overlap (`npm run eval` vs `simulations/`)
actively misleads.

### Possible fix

Add `npm run sim`:
```
npm run sim -- <org> --suite <name> --target <assistant-or-squad>
npm run sim -- <org> --simulations <n1>,<n2> --target <assistant>
npm run sim -- <org> --suite <name> --watch
```
Reuse `src/eval.ts`'s local-name → UUID resolver and
`src/api.ts:vapiRequest`. Print pass/fail summary on completion.

Renaming `npm run eval` to disambiguate is a separate, backwards-
incompatible follow-up.

### Status

**Open.** Targeted by **Stack E**.

---

## 17. State file key-order churn produces noisy diffs

**Discovered:** customer-fork log (Mudflap #1, 2026-04-28)

### Problem

After pushes, the diff of `.vapi-state.<env>.json` includes reorderings
of the section objects. Same keys, same UUIDs — just emitted in a
different insertion order. About half the diff is pure reordering.

### Current behavior (Verified)

`src/state.ts:55-64` (`saveState()`) calls `JSON.stringify(state, null,
2)` with no key sorter. JS `JSON.stringify` preserves insertion order;
maps merged from multiple sources (push, pull, bootstrap) end up with
unpredictable orders.

### Risk

Noisy state-file diffs hide the actually meaningful entries (new UUIDs,
removed entries) under a wall of reorderings. Reviewers rubber-stamp
state file changes because they're hard to read.

### Possible fix

Add `sortedKeysReplacer` to `JSON.stringify` so object keys serialize
alphabetically. Preserve the atomic write pattern in
`src/state.ts:60-62`.

**One-time noise:** the first push after this lands produces a
state-file diff of pure reordering across every customer. Worth calling
out in the PR description.

### Status

**Open.** Targeted by **Stack B**.

---

## 18. Structured-output evaluation `name` capped at 40 chars with no client-side validation

**Discovered:** customer-fork log (Mudflap #9, 2026-04-29)

### Problem

Structured-output `evaluations[].structuredOutput.name` is capped at 40
characters server-side. The engine accepts a 51-char name, posts it,
and only fails when the API returns 400 mid-push.

### Current behavior (Verified)

Push partway through a multi-resource apply. By the time the scenario
errored, both assistants and one new personality had already been
applied AND the state file had been written with the new personality
UUID. The push left the dashboard in an intermediate state.

### Risk

Failure happens partway through a multi-resource push. Recovery is
non-obvious. Engineers naturally write self-describing names that
exceed the cap.

### Possible fix

Client-side validator (`npm run validate`) that walks every assistant
`name` and every `evaluations[].structuredOutput.name` in scenarios.
Fail fast (with the offending field path printed) before any API call.
Same validator can apply the cap to other known-finite fields (e.g.
assistant `name` capped at 40 too).

### Status

**Open.** Targeted by **Stack D**.

---

## 19. No engine warning when `maxTokens` is too low for a tool-using assistant

**Discovered:** customer-fork log (Mudflap #10, 2026-04-29)

### Problem

Any engineer can write `maxTokens: 1` (or 10, or 25) into an assistant
`.md`. The engine syncs it to the dashboard with no warning. The first
symptom on a real call is a malformed tool-call payload — opaque to
debug. Risk window is widest when an engineer is *trying to suppress
speech* on a silent classifier.

### Current behavior

**Verified in engine:** the push pipeline passes `maxTokens` through
unchanged. **Needs platform validation:** the exact OpenAI / provider
behavior at low `maxTokens` boundary is provider-specific; the customer
log cites OpenAI streaming behavior at `maxTokens: 1` that returns
`finish_reason: 'length'` mid-JSON for tool calls.

### Possible fix

At validate / push time, for any assistant with non-empty
`model.toolIds`, compute a soft floor:
`floor ≈ 25 + sum(len(JSON.stringify(tool.function.parameters)) for tool in tools)`.
If `model.maxTokens < floor`, warn (non-blocking).

### Status

**Open.** Targeted by **Stack D**.

---

## 20. Prompt vocabulary leaks into TTS

**Discovered:** customer-fork log (Mudflap #11, 2026-04-29)

### Problem

A prompt section heading or example word that names a tool argument can
become a TTS contaminant. Customer log: a `# Reasoning Channel
Discipline` section with `Reason.` examples caused the model to open
turns with `"Reason."` as a TTS preface. Squad regressed 7/18 → 4/18.

### Current behavior (Verified)

The engine treats prompts as opaque text. No surface to detect this
class of regression at push time.

### Risk

Prompt-authoring footguns ship clean through the engine. Discovered
days later via sim regressions; attribution to the prompt's literal
word choice is non-obvious.

### Possible fix

Heuristic only — a real fix requires linguistic modeling out of scope
for an engine intervention:

1. If a prompt body contains a structured concept word (`Reason`,
   `Reasoning`, `Channel`, `Discipline`, `Argument`, etc., capitalized)
   AND the assistant has a tool whose parameter has the same name, warn
   at validate time.
2. Templating convention `<<arg:reason>>` is overkill but worth thinking
   about.

The full fix lives in `docs/learnings/assistants.md` as a known
regression shape.

### Status

**Open.** Targeted by **Stack D** as a heuristic; entry stays open to
flag that the heuristic is partial.

---

## 21. `.vapi-ignore` was pull-only — push and orphan-detect ignored the list

**[RESOLVED 2026-05-11] (#TBD)**

**Discovered:** during the symmetric-ignore plan review — a `--force` push
in a fresh customer org would happily DELETE a dashboard assistant that the
repo had explicitly opted out of managing via `.vapi-ignore`, just because
the local file was absent. Data-safety incident waiting to happen.

### Problem

`.vapi-ignore` (gitignore-flavored opt-out list at
`resources/<org>/.vapi-ignore`) was honored on `pull` only. `push` and
`apply` loaded all on-disk resources unconditionally, validated them, and
sent them. Orphan-detect computed "in state but not in local files" without
consulting the ignore list, so a state-mapped resource whose local file had
been removed would be queued for DELETE under `--force` — even when its id
was explicitly listed in `.vapi-ignore`.

### Current behavior (Verified)

- `src/resources.ts` `loadResources()` accepts `{ ignorePatterns }`; matched
  ids emit `🚫 <id> (matched .vapi-ignore: <pattern>)` and are filtered out
  before duplicate detection or parsing.
- `src/push.ts` reads `const ignorePatterns = FORCE_DELETE ? [] : loadIgnorePatterns()`
  and passes it into every `loadResources` call. `--force` bypasses the
  load-filter for deliberate overrides.
- `src/delete.ts` `findOrphanedResources()` accepts an `ignoredIds: Set<string>`;
  matched ids are excluded from the orphan list. `deleteOrphanedResources`
  computes the matched set per type and emits
  `🚫 <type>/<id> retained (matched .vapi-ignore — orphan-protected)` so the
  retention is visible. Orphan-protect ALWAYS honors the list — `--force`
  does not bypass it.
- `src/validate.ts` `validateNoIgnoredReferences()` walks each loaded
  resource's referenced ids and emits an `error`-severity finding for any
  ref pointing at an ignored id. `--strict` push aborts before any API call.

### Risk

Silent dashboard deletion of a resource the repo had explicitly declined to
manage. Hardest possible class of mistake to recover from in production.

### Resolution

Symmetric load-filter + orphan-protect + reference validator, with `--force`
bypassing the load-filter but never bypassing orphan-protect. Test coverage
in `tests/vapi-ignore-push.test.ts` (T1–T5 spawn-fixture integration tests +
in-process unit tests for each helper).

### Status

RESOLVED 2026-05-11 (#TBD — PR number updates when opened).

---

## 22. Dashboard rename of a tracked resource recreated the local file (duplicate per UUID)

**[RESOLVED 2026-06-03] (#TBD)**

**Discovered:** during a `vitali-org` pull after renaming an assistant in the
dashboard ("call-transfer-test" → "call-transfer-test-1"). Pull created a
second file `call-transfer-test-1-c95f4c6b.md` next to the existing
`call-transfer-test-c95f4c6b.md` — two files for one UUID.

### Problem

The engine treated the local filename slug as if it had to track the
dashboard `name`. Renaming a resource on the dashboard caused pull to mint a
new name-derived slug and write a duplicate file, orphaning the original.

### Current behavior (was)

`pullResourceType` (`src/pull.ts`) looked up the tracked resourceId by UUID,
then discarded it via `resourceIdMatchesName` whenever the dashboard `name`
no longer matched the slug — falling through to `generateResourceId` and
producing a `<name>-<uuid8>` duplicate. The push side mirrored the same
assumption: `getInvalidStateMappings` (`src/push.ts`) flagged the rename as
`name_mismatch` and forced a bootstrap that re-keyed state to the
name-derived slug, so the next push created a duplicate on the dashboard too.

### Risk

Silent duplication: two local files per UUID on pull, and (via apply) a
duplicate dashboard resource on the subsequent push. Confusing state, lost
edits, orphan cleanup required.

### Resolution

The filename slug is now a stable local handle, fully decoupled from the
dashboard `name`. On pull, an already-tracked UUID keeps its existing
resourceId verbatim — a rename only updates file content, never the filename
(holds under `--force` too). On push, `name_mismatch` was removed from
`getInvalidStateMappings`; only `missing_remote` (genuinely stale state) now
triggers a bootstrap. New slugs are still minted only when the UUID is
unknown to state (genuinely new resource or cross-env adoption — the
same-name-twin adoption guard in `findExistingResourceId` is unchanged).
Regression coverage: `tests/pull-rename-preserves-filename.test.ts`.

### Status

RESOLVED 2026-06-03 (#TBD — PR number updates when opened).

---

## 23. Phantom `both-diverged`: canonicalization trapped in pull.ts + a gate that blocked when local and dashboard already agreed

**[RESOLVED 2026-06-03] (#TBD)**

**Discovered:** a scoped `npm run push` of an unedited assistant blocked with
`❌ drift detected ... [both-diverged]` and "Applied 0 resource(s)", even
though the local file matched the dashboard. A first fix looked like it
worked — but it was only ever verified with `--dry-run`, which **skips the
drift check entirely**, so the real push path was never exercised. The block
came back on the first real push.

### Problem (two layers)

**Layer 1 — canonicalization was trapped in `pull.ts` (architectural smell).**
`canonicalizeForHash` (the single basis pull writes `lastPulledHash` in:
resourceId refs, credential names, prompt-in-body, `_platformDefault` marker)
lived in `pull.ts`. Because `pull.ts` imports `drift.ts`, `drift.ts` could not
import it back (cycle) — so it grew a **divergent duplicate**
(`stripServerFields` / `SERVER_FIELDS`, byte-identical to pull's
`cleanResource` / `EXCLUDED_FIELDS`) plus a dead `hashPlatformResource`. The
first fix bridged the gap with an injected `hashPlatformPayload` callback +
manual hash plumbing at the push call site — a patch around the module
placement, not the root cause.

**Layer 2 — the real phantom (the bug the patch never reached).** Even with
matching bases, an untouched resource blocked because the **gate** treated a
stale baseline as a conflict. A diagnostic on the live resource:

```
hashLocalResource (local file)      : 54734d2b…
platformHash (canonicalized remote) : 54734d2b…   ← byte-identical
state lastPulledHash                : 3a83baba…   ← stale (older basis)
```

Local and dashboard **agreed perfectly** — nothing to reconcile. But
`classifyDrift` returns `both-diverged` whenever both live sides differ from
the baseline (a deliberate, test-pinned *descriptive* contract), and
`checkDriftForUpdate` only short-circuited on `platformHash === lastPulledHash`.
So a stale baseline (every resource in a freshly-upgraded customer repo, whose
`lastPulledHash` was written in an older hash basis) manufactured a conflict
where none existed.

### Risk

Push/apply unusable for normal resources without `--overwrite` — the exact
escape hatch that silently clobbers concurrent dashboard edits. The phantom
drift trained operators to reach for the dangerous flag on every push.

### Resolution

1. **Extracted `src/canonical.ts`** (dependency-light: credentials + types).
   It holds `VapiResource`, `EXCLUDED_FIELDS`, `cleanResource`,
   `buildReverseMap`, `resolveReferencesToResourceIds`, and
   `canonicalizeForHash`. `pull.ts`, `push.ts`, `audit.ts`, AND `drift.ts` now
   import the ONE definition. Deleted drift's duplicate field-strip and the
   dead `hashPlatformResource`. `checkDriftForUpdate` computes platform + local
   hashes itself (no injected callback, no hash plumbing at the call site).
2. **Fixed the gate, not the classifier.** `checkDriftForUpdate` now returns
   `match` (no-op, never blocks) when `localHash === platformHash`, regardless
   of the baseline. `classifyDrift` keeps its descriptive `both-diverged`
   contract (it still signals the stale pointer) — policy lives in the gate.

Regression coverage: `tests/push-stale-baseline-noop.test.ts` (e2e — stale
baseline + local==dashboard → push applies, no block) and `tests/drift.test.ts`
(canonicalization resolves tool UUID→slug so a clean resource matches baseline).

### Lesson

`--dry-run` is NOT a verification of the drift path — it skips it. Verify
push-gate changes with a real (idempotent) push or the e2e harness.

### Status

RESOLVED 2026-06-03 (#TBD — PR number updates when opened).

---

## Out of scope (intentionally not improvements)

- **State file is identity-only and not git-ignored.** It's intentionally
  committed so all collaborators share the same local→UUID mapping.
  The proposal in #4 is *additive* — keep identity mappings, add
  content hashes.
- **`push -- <env>` does not require an interactive confirmation prompt.**
  That's a UX choice — adding a prompt would break automation. The right
  place to add friction is `--dry-run` (#5).
- **No environment-cross-pollination guard.** `push -- <env>` only
  touches `resources/<env>/` — this is correct and documented in
  `AGENTS.md`. Don't conflate that with drift detection.
- **Renaming `npm run eval` to disambiguate from `npm run sim`.**
  Backwards-incompatible script change; raise as a separate issue.
