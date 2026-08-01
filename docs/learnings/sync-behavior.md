# Sync behavior: every pull / push / apply scenario

This is the authoritative behavior matrix for the sync engine. If you're unsure
what `pull`, `push`, or `apply` will do to a resource in a given situation,
find the scenario here. Every row is derived from the engine source
(`src/pull.ts`, `src/push.ts`, `src/apply.ts`, `src/drift.ts`).

---

## The four artifacts

Every resource is described by four independent things. All sync behavior is a
function of which of them exist and whether their contents agree.

| Artifact | Where | Committed? | Meaning |
|---|---|---|---|
| **Local file** (`L`) | `resources/<org>/<type>/<name>.md\|yml` | yes | The declarative source of truth you edit |
| **State entry** (`S`) | `.vapi-state.<org>.json` → `{ "<name>": { "uuid": … } }` | yes | The ONLY thing state stores: which platform UUID a local name is bound to |
| **Baseline** (`B`) | `.vapi-state-hash/<org>/<uuid>` | **no** (per-developer, gitignored) | sha256 of the last platform content *you* saw (last pull or push) |
| **Dashboard resource** (`D`) | Vapi platform | n/a | What's live |

**One letter per artifact — the same letter for the thing and for its hash.**
`L` means both the local file and the hash of its contents; `D` means both the
live dashboard resource and the hash of its contents; `B` is a hash already.
Comparisons below are always between hashes.

The local **filename is organizational only** — content hashes never include
it. The file↔UUID link is owned entirely by the state entry; the baseline is
keyed by UUID, so renames don't invalidate it.

### Who writes the baseline

| Event | Baseline becomes |
|---|---|
| `pull` writes/rewrites a file | hash of the file **as written to disk** |
| `push` POST/PATCH succeeds | hash of the **API response** (what the platform actually stored) |
| post-apply tool/SO linking PATCH | hash of the linking response (avoids self-inflicted drift) |
| `pull --resolve=ours` on a conflict | the platform hash at resolve time (so next classify = `local-ahead`) |
| resource deleted (404 recovery, `cleanup --force`) | baseline file deleted |

### The drift triangle

With all four artifacts present, compare three hashes — local file (`L`),
baseline (`B`), dashboard (`D`) — all computed in the same canonical basis
(`canonicalizeForHash`: server fields stripped, UUID refs → slugs, credential
UUIDs → names):

| L vs B | D vs B | Direction | Meaning |
|---|---|---|---|
| = | = | `clean` | Nobody changed anything |
| ≠ | = | `local-ahead` | You edited locally; dashboard untouched → **your change is the natural next step UP** |
| = | ≠ | `dashboard-ahead` | Someone edited the dashboard; you didn't → **their change is the natural next step DOWN** |
| ≠ | ≠ (but L = D) | treated as `clean` | Both sides already agree; the baseline is just stale → self-heals, never blocks, never prompts |
| ≠ | ≠ (and L ≠ D) | `both-diverged` | True 3-way conflict — the only case a human is ever asked about |

> **The core principle:** a question is only ever asked **per resource**, and
> only for `both-diverged`-class situations at push time. Everything else has
> one obviously-correct direction and flows silently.

---

## Content scenarios (resource exists everywhere: L + S + B + D)

### 1. Nothing changed (`clean`)

| Command | Behavior |
|---|---|
| `pull` | 📝 rewrites the file (content no-op), refreshes baseline from disk |
| `push` | `D == B` → PATCH proceeds silently (content no-op), baseline := response hash |
| `apply` | both of the above; fully silent |

### 2. Local changed, dashboard didn't (`local-ahead`)

| Command | Behavior |
|---|---|
| `pull` | ⬆️ local file preserved as-is; baseline untouched |
| `push` | `D == B` → **pushed silently, no question** (your edit is the natural next step); baseline := response hash |
| `apply` | pull preserves → push silent |

### 3. Dashboard changed, local didn't (`dashboard-ahead`)

| Command | Behavior |
|---|---|
| `pull` | ⬇️ dashboard version **synced down over the unchanged local file**, baseline refreshed. Nothing is lost — local had no edits. (Mirror of the silent-push rule.) |
| `push` (without pulling first) | `D ≠ B` → conflict path: TTY prompt / CI block. Note: choosing "push local" here would **revert** the dashboard edit — usually you want "keep dashboard", then pull. |
| `apply` | pull stage syncs it down → push stage sees clean → **silent, no prompt** |

### 4. Both changed differently (`both-diverged`) — the only real conflict

| Command | Behavior |
|---|---|
| `pull` (plain) | conflict listed with hashes, **exit 1** demanding `--resolve=ours\|theirs\|fail\|defer`; nothing written, baseline intact so the conflict stays detectable |
| `pull --resolve=ours` | local file kept; baseline := platform hash → next push classifies `local-ahead` and pushes silently (deliberate take-ownership) |
| `pull --resolve=theirs` | ⬇️ local **overwritten** with dashboard (local edits lost); baseline := disk hash |
| `pull --resolve=fail` | exit 1, nothing written (CI gate) |
| `pull --resolve=defer` | ⏳ file AND baseline left untouched, exit 0 — conflict handed to push's per-resource prompt |
| `push` (TTY) | **per-resource prompt**: ① *Push my local version* → PATCH + baseline := response ② *Keep dashboard* → ⏭️ skip, local untouched, baseline untouched (conflict re-detected next push until reconciled) ③ *Save dashboard copy* → 📄 writes `<name>.<TIMESTAMP>.bkp.<ext>` beside your file, skip push; merge by hand, push again, choose ① |
| `push` (CI / piped) | ❌ blocked for that resource (others continue); `--overwrite` pushes local |
| `apply` (default `--resolve=defer`) | pull defers → push prompts for **exactly the conflicted resources**; clean ones flow silently |
| `apply --resolve=ours` | no questions: pull re-baselines, push runs with `--overwrite` (CI semantics; dashboard edits lose) |

### Conflict timing context (advisory)

When a 3-way conflict is reported, each entry carries a timing line beside the
hashes:

```
     - assistants/intake
       local-hash: 3f9a1c2b…   platform-hash: 8e01d4aa…   last-pulled: 3f9a1c2b…
       dashboard changed 2026-08-01 15:00Z, your file 2026-08-01 12:00Z — dashboard is 3h newer
```

It is a hint, never a verdict, and the engine still refuses to choose. Three
reasons it cannot be trusted as one:

- `updatedAt` is bumped by **our own pushes**, so a "newer" dashboard often just
  means you pushed a few minutes ago.
- The local mtime is reset by `git clone` and `git checkout`, so on a fresh
  checkout every file looks edited seconds ago.
- **Later does not mean supersedes.** If you changed the prompt and a teammate
  changed the voice, both edits deserve to survive; last-write-wins would discard
  one silently.

Sub-minute gaps are reported as "within a minute of each other" rather than
picking a winner, because clock skew is the same order of magnitude as the gap.

A previous state schema stored `lastPulledAt` for this purpose and it was
deliberately removed in favour of content hashes. This line reads `updatedAt`
from the live response and the file's mtime at report time; it persists nothing.

### 5. Both changed identically (L = D, stale baseline)

Both `pull` and `push` treat this as clean (live sides agree — nothing to
reconcile). The no-op write/PATCH re-seeds the baseline, self-healing the
stale pointer. Never blocks, never prompts.

---

## Existence scenarios (something is missing somewhere)

### A. File created locally, no resource on the dashboard yet (L only)

| Command | Behavior |
|---|---|
| `validate` | schema-checked like any resource |
| `push` | **orphan-YAML gate**: refuses with exit 1, listing the file and possible rename-source candidates. Intentional — the engine can't tell "new resource" from "renamed file" from "stale cruft". After confirming it's genuinely new: `push --allow-new-files` → POST create → state entry + baseline (from response). If a dashboard resource with the **same name** already exists, the engine adopts its UUID instead of creating a duplicate (dep-dedup). |
| `pull` | untouched — pull only visits resources the dashboard has |
| `apply` | pull stage no-op for it; push stage hits the gate (pass `--allow-new-files` through apply) |

### B. Resource on the dashboard, nothing local (D only)

| Command | Behavior |
|---|---|
| `pull` | ✨ file created (`<name-slug>-<uuid8>`), state entry + baseline written |
| `push` | invisible — nothing local references it; plain push never deletes it |
| `audit` | flagged as a dashboard orphan |

### C. File deleted locally, still on the dashboard (S + B + D, no L)

| Command | Behavior |
|---|---|
| `pull` | 🗑️ deletion intent honored — file is NOT re-materialized; state entry kept |
| `push` / `apply` | resource not loaded → state-without-file = orphan candidate. Without `--force`, the dashboard is left untouched and the pending deletion is printed. With `--force`, reference-safe state-tracked orphans are deleted in reverse dependency order. `promotion.yml` uses this path only after its scoped mirror has removed the matching destination file. |
| to stop tracking entirely | add it to `.vapi-ignore` (it will never re-appear on pull) |

`cleanup --force --confirm <org>` remains the explicit whole-org cleanup verb.
For ordinary GitOps deletion, `apply --force` is the deliberate deletion gate;
for cross-org promotion, the reviewed promotion resource patterns are the
additional ownership boundary.

### D. Tracked locally, deleted on the dashboard (L + S + B, no D)

| Command | Behavior |
|---|---|
| `push` | drift GET hits 404 → stale state mapping dropped, baseline deleted, resource **skipped this run** with a warning. The file is now case A — the next push hits the orphan gate, and `--allow-new-files` recreates it (deliberately requires re-confirmation). |
| `pull` | resource absent from the dashboard list → its state entry drops out of the rewritten state file; the local file remains and becomes case A |

### Listing completeness

Vapi list endpoints return at most 100 items per request and offer no page
cursor, only `createdAt` comparison filters. `fetchAllResources` pages backwards
through `createdAt` until a short page proves it reached the end, deduping by id
(the cursor is inclusive, so an item sharing the boundary timestamp is re-read
rather than skipped).

If the walk cannot be completed — the endpoint ignores the cursor params, the
payload carries no `createdAt`, or the page-count backstop trips — the engine
warns and the listing must be treated as a partial view. Anything that reads
"absent from the listing" as "deleted on the dashboard" is wrong on a partial
view; that includes push's `missing_remote` detection and `delete`'s orphan
sweep, which consume the resources today without consuming the verdict.

### E. Fresh clone / new developer (L + S committed, but B is per-dev and missing)

| Command | Behavior |
|---|---|
| `pull` | direction unknown (`no-baseline`) → falls back to git/mtime modified-detection: modified files ✏️ preserved; unmodified files 📝 rewritten — and the baseline is seeded. **Run a plain pull first on any fresh clone.** |
| `push` (without pulling first) | drift check skipped with a warning, PATCH proceeds, baseline seeded from the response. Risk window: this one push cannot detect dashboard drift. |
| `audit` | `no-baseline` info findings (do not block CI) |

### F. Legacy state file (pre-migration, carries `lastPulledHash`/timestamps)

`pull`, `push`, and `apply` all **hard-refuse** with
`Run \`npm run migrate\` first.` The migration (no org argument, no token
needed) slims every `.vapi-state.<org>.json` to `name → { uuid }` and seeds
each org's `.vapi-state-hash/` from the legacy hashes. Idempotent.

### G. Local file renamed

State is keyed by the old name → the new name is an orphan (case A) and the
old name is a ghost (case C) simultaneously. The orphan gate detects the pair
(shared base slug) and tells you the fix: rename back and pull, or re-key
deliberately.

### H. `.vapi-ignore` match

Skipped in **both** directions: never written by pull, never sent by push,
orphan-protected against `--force` deletion. A resource referencing an ignored
resource is a validation error.

### I. Backup copies (`<name>.<TIMESTAMP>.bkp.md|yml`, legacy `<name>.dashboard.*`)

Written by push prompt option ③. Invisible **everywhere**: resource loader,
orphan gate, audit, interactive picker, explicit CLI paths (refused with 🚫),
and gitignored (`*.bkp.*`). They can be diffed and merged from — never pulled,
pushed, or counted.

## Cross-org promotion deletions

Promotion mirrors the committed source resource tree into downstream orgs; it
does not deploy the source org itself. A safe deletion therefore has two
separate lifecycles:

1. Delete the source resource file in a reviewed Git change, but retain its
   `.vapi-state.<source>.json` entry. The entry is the deletion tombstone.
2. Review `npm run promote` and merge or apply it. Only matching destination
   paths are removed, in reverse dependency order.
3. An automatic `--all --apply` run carries that authorization through every
   adjacent org even after the intermediate org removes its own state entry.
4. Verify the destination APIs return 404 and the bot commit removed the
   destination files and UUID mappings.
5. Reconcile the source org separately with a scoped
   `npm run apply -- <source> --force <deleted-file-path...>`, then commit the
   cleaned source state.

Do not delete the source state mapping or refresh it away before step 2. With
no source files and no tombstone, promotion refuses the empty-source mirror
instead of guessing that a full destination wipe was intended.

---

## Flag cheat sheet

| Flag | Verb | Effect |
|---|---|---|
| `--resolve=defer` | pull, apply (default for apply) | leave conflicts for push's per-resource prompt |
| `--resolve=ours` | pull, apply | keep local fleet-wide, re-baseline; apply adds `--overwrite` to push |
| `--resolve=theirs` | pull, apply | overwrite local fleet-wide with dashboard |
| `--resolve=fail` | pull, apply | exit 1 on any conflict (CI) |
| `--overwrite` | push | skip the drift gate/prompt, push local unconditionally |
| `--force` | pull | nuke-and-rematerialize local from dashboard (bypasses ALL preservation) |
| `--force` | push/apply/cleanup | enable deletions of dashboard orphans |
| `--allow-new-files` | push/apply | bypass the orphan-YAML gate (confirm each orphan is genuinely new first) |
| `--bootstrap` | pull | refresh state + baselines without writing resource files |
| `--dry-run` | push | print would-be calls; no API calls, no baseline writes, no prompts |

## Interactivity rule

The per-resource conflict prompt fires only when stdin **and** stdout are a
TTY. CI / piped runs keep deterministic behavior: conflicted resources are
blocked (exit messaging tells you the direction), `--overwrite` /
`--resolve=*` make the decision explicit. `apply` spawns pull/push with
inherited stdio, so prompts reach the operator in interactive apply too.
