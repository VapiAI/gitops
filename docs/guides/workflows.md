# Everyday workflows

Recipes for common situations. Each one is the safe path — there are faster shortcuts, but use them only when you understand the trade-offs. The single most important habit: **prefer `apply` over `push`**, because `apply` refreshes platform state before mutating, protecting you against dashboard edits made between your last pull and your push.

## Daily edit-and-deploy

```bash
# 1. Schema-check locally first — fails fast on YAML shape errors, no network needed.
npm run validate -- <org>

# 2. Deploy via apply: pulls latest platform state, merges with your local
#    changes, then pushes the merged result. Safe against drift.
npm run apply -- <org>
```

## Iterating on a single file

```bash
npm run validate -- <org>
npm run apply -- <org> resources/<org>/assistants/my-agent.md
```

`apply` accepts the same path-scoping as `push`, so you get safety + targeted scope in one command.

## First push into a fresh org

```bash
# Interactive wizard — pick "no resources" if you'll author from scratch.
npm run setup

# Drop your YAML/MD files into resources/<org>/, then:
npm run validate -- <org>
npm run apply -- <org>
```

On a fresh org, `apply`'s pull phase bootstraps `.vapi-state.<org>.json` from the empty dashboard before pushing your local creates.

## Creating new resources after the first push (orphan-YAML gate)

After the initial setup, **`push` refuses by default** when it sees a local YAML file that has no entry in the state file. The engine can't tell whether the file is:

- (a) a NEW resource you intentionally want to create,
- (b) a RENAME of an existing resource (state has the old slug; YAML has the new name), or
- (c) a MOVED file (file copied or restored without state being re-keyed).

Silently treating every orphan as case (a) used to spawn duplicates on the dashboard. The gate halts push with a verbose message listing every orphan, and pairs each orphan with possible "rename source" candidates (state entries with no matching local file that share a base slug).

To proceed when the orphans are genuinely new resources:

```bash
npm run push -- <org> --allow-new-files
```

This works on `apply` too: `npm run apply -- <org> --allow-new-files` propagates the flag through to the push stage.

**For AI agents**: do NOT auto-pass `--allow-new-files` without confirming with the human. The gate's verbose message is designed to be surfaced to the user so they can reclassify each orphan (new vs rename vs cruft). Silent bypass defeats the gate.

Suppressed automatically:
- Explicit `--bootstrap` runs (population-from-scratch is expected to be all-new).
- Files matched by `.vapi-ignore` (the engine wasn't going to upload them anyway).
- Selective push (`-- <path>`) where the orphan is outside the selection.

## Pulling without losing local work

```bash
# Local-first by default — won't overwrite locally modified files.
npm run pull -- <org>

# State-only refresh — re-sync UUID mappings without writing resource files locally.
npm run pull -- <org> --bootstrap

# Pull a single known remote resource by UUID.
npm run pull -- <org> --type assistants --id <uuid>
```

## Live testing what you just deployed

```bash
# Interactive WebSocket call — speak/listen from the terminal.
npm run call -- <org> -a <assistant-name>
npm run call -- <org> -s <squad-name>

# Automated simulation suite against the deployed resource.
npm run sim -- <org> --suite <suite-name> --target <assistant-name>
```

## Recovering from a bad deploy

```bash
# Every push/apply writes a snapshot first. List them:
npm run rollback -- <org> --list

# Re-apply a specific snapshot to undo a deploy:
npm run rollback -- <org> --to <ISO-timestamp>
```

## Cleaning up orphaned dashboard resources

```bash
# Dry-run by default — shows what would be deleted, makes no changes.
npm run cleanup -- <org>

# Destructive run — requires explicit confirmation:
npm run cleanup -- <org> --force --confirm <org>
```

**Surgical alternative when the orphan set includes Vapi-default fixtures** (e.g. the seven undeletable stock simulation personalities — see `docs/learnings/simulations.md`): delete individual resources via direct API call, then refresh state:

```bash
curl -X DELETE -H "Authorization: Bearer $VAPI_PRIVATE_API_KEY" \
  https://api.vapi.ai/assistant/<orphan-uuid>
npm run pull -- <org> --bootstrap
```

This avoids `--force` halting on the first immortal-default 404.

## When to use raw `push` instead of `apply`

Almost never. The only honest case: you just ran `pull`, nothing else has touched the dashboard since, and you need to skip the merge pass for speed. In any multi-developer environment, default to `apply`.

If you do use `push`, dry-run it first:

```bash
npm run push -- <org> --dry-run
```

## Pre-flight checklist before any deploy

1. `git status` — uncommitted changes are intentional?
2. `npm run validate -- <org>` — schema clean?
3. `npm run apply -- <org>` (or `apply -- <org> <path>` for single-file)
4. After: verify with `npm run call -- <org> -a <name>` or a `npm run sim` suite
5. If something looks wrong: `npm run rollback -- <org> --list`

## How to Use This Repo

1. **Run `npm run setup`** to configure your first org (or `npm run setup -- <org>` without a terminal)
2. **Edit resources** in `resources/<org>/` (`.md` assistants, `.yml` tools/squads/etc.)
3. **Validate** with `npm run validate -- <org>`
4. **Deploy** with `npm run apply -- <org>` (pull → merge → push)

Use:

- `apply` for deploys — the default; safe against dashboard edits made since your last pull
- `pull` when Vapi might have changed and you only want to sync down
- `push` only right after a `pull`, when nothing else has touched the dashboard (see [When to use raw `push`](#when-to-use-raw-push-instead-of-apply))

### Bootstrap State Sync

Use bootstrap pull when you need the latest platform IDs and org-local bindings without downloading all remote resources:

```bash
npm run pull -- my-org --bootstrap
```

This refreshes `.vapi-state.<org>.json`, credential mappings, and the generated credential/phone-number block in `.env.<org>` while leaving `resources/<org>/` untouched. Setup and ordinary pulls perform the same binding refresh. If you skip this step, `push` will automatically run it when it detects empty or stale state.

### Pulling a Single Resource By UUID

```bash
npm run pull -- my-org --type squads --id <squad-uuid>
```

`--id` must be paired with exactly one resource type.

### Pulling Without Losing Local Work

By default, `pull` preserves any files you've locally modified or deleted:

```bash
npm run pull -- my-org
# ⏭️  my-assistant (locally changed, skipping)
# ✨  new-tool -> resources/my-org/tools/new-tool.yml
```

Detection works in three layers, so it covers both day-to-day and fresh-clone
workflows:

1. **Content baseline (primary)** — each resource's last-seen platform hash
   lives in the per-developer `.vapi-state-hash/<org>/<uuid>` store
   (gitignored). Comparing local / baseline / dashboard hashes classifies
   every resource as clean, local-ahead (preserved ⬆️), dashboard-ahead
   (synced down ⬇️ — local was unchanged, nothing to lose), or both-diverged
   (gated behind `--resolve=ours|theirs|fail|defer`). See
   `docs/learnings/sync-behavior.md` for the full matrix.
2. **Git-tracked changes** — when no baseline exists yet, files that show up
   in `git status` (modified, deleted, or individually untracked) are
   preserved.
3. **mtime fallback** — if git can't help (no commits yet, the resource tree
   isn't tracked at all, or git just had nothing to say), files that are
   newer than `.vapi-state.<org>.json` are still preserved. This is the safety
   net for the "fresh clone, edit a file, run pull again" case.

Interactive `npm run pull` defaults to local-first too — it asks
`Overwrite locally modified files?` (default `No`) before forwarding the
pull. Pass `--force` directly (or answer `Yes` to that prompt) to overwrite
everything with the platform version.

### Selective Push

Push only specific resources instead of everything:

```bash
# By resource type
npm run push -- my-org assistants
npm run push -- my-org tools

# By specific file (long form)
npm run push -- my-org resources/my-org/assistants/my-assistant.md

# By specific file (short form — folder/filename)
npm run push -- my-org assistants/my-assistant.md
npm run push -- my-org simulations/personalities/skeptical-sam.yml

# Multiple files
npm run push -- my-org resources/my-org/assistants/a.md resources/my-org/tools/b.yml
```

> A bare resource id like `npm run push -- my-org my-assistant` (no folder,
> no extension) is **rejected explicitly**. The CLI prints
> `Unrecognized argument: my-assistant` and exits with a non-zero code rather
> than silently falling through to a full apply. Pass either a type
> (`assistants`) or a path (`assistants/my-assistant.md`).

### Auto-Dependency Resolution

When pushing a single squad or assistant, missing dependencies (tools, structured outputs, etc.) are automatically created first:

```
Squad push
  └─ missing assistants? → auto-create them first
       └─ missing tools / structured outputs? → auto-create those first
  └─ all references resolved → create the squad ✓
```
