# Everyday workflows

Recipes for common situations. Each one is the safe path — there are faster
shortcuts, but use them only when you understand the trade-offs. The single
most important habit: **prefer `apply` over `push`**, because `apply`
refreshes platform state before changing anything, protecting you against
dashboard edits made since your last pull.

## Deploy changes

```bash
# 1. Schema-check locally first — fails fast on YAML shape errors, no network needed.
npm run validate -- <org>

# 2. Deploy via apply: pulls latest platform state, merges with your local
#    changes, then pushes the merged result. Safe against drift.
npm run apply -- <org>
```

CI runs the same validation on every pull request, for every org under
`resources/` (the **Validate resources** check in `.github/workflows/ci.yml`).
It needs no secrets, so it runs on forks too. Make it a required check in
branch protection, so a config that `apply` would refuse can't reach
`main`, where it would block deploys and promotion.

To deploy only some resources, pass resource types or file paths. `apply`
and `push` accept the same scoping:

```bash
# By resource type
npm run apply -- <org> assistants

# By file (long form, or short form: folder/filename)
npm run apply -- <org> resources/<org>/assistants/my-agent.md
npm run apply -- <org> assistants/my-agent.md

# Several files
npm run apply -- <org> assistants/a.md tools/b.yml
```

A bare resource ID (`npm run apply -- <org> my-agent`, with no folder or
extension) is rejected with `Unrecognized argument: my-agent`, rather than
falling through to a full deploy. Pass a type or a path.

When you deploy a single squad or assistant, its missing dependencies are
created first:

```
Squad push
  └─ missing assistants? → auto-create them first
       └─ missing tools / structured outputs? → auto-create those first
  └─ all references resolved → create the squad ✓
```

## Join an existing repository

After cloning a repository someone else set up, connect each org (see the
README's quick start), then run a plain pull before your first deploy:

```bash
npm run pull -- <org>
```

This seeds your local drift baselines (`.vapi-state-hash/`, per developer and
gitignored), so later pulls and deploys can tell your edits from changes made
in the dashboard.

## Start in a fresh org

```bash
# Interactive wizard — pick "no resources" if you'll author from scratch.
npm run setup

# Drop your YAML/MD files into resources/<org>/, then:
npm run validate -- <org>
npm run apply -- <org>
```

On a fresh org, `apply`'s pull phase creates `.vapi-state.<org>.json` from
the empty dashboard before pushing your new resources.

## Create new resources after the first deploy

After the initial setup, **`push` and `apply` stop** when they find a local
file with no entry in the state file. The engine can't tell whether the file
is:

- (a) a NEW resource you intentionally want to create,
- (b) a RENAME of an existing resource (state has the old name; the file has the new one), or
- (c) a MOVED file (copied or restored without the state being updated).

Treating every one as new would create duplicates on the platform, so the
deploy halts with a message listing each file, paired with possible "rename
source" candidates (state entries with no matching local file that share a
base name).

When the files are genuinely new resources:

```bash
npm run apply -- <org> --allow-new-files
```

Check each listed file before you pass the flag: it confirms every one is
new. If a coding agent runs your deploys, it should show you the list rather
than pass the flag itself; [`AGENTS.md`](../../AGENTS.md) instructs it to.

The check is skipped for:

- explicit `--bootstrap` runs, where everything is expected to be new;
- files matched by `.vapi-ignore`, which aren't uploaded anyway;
- files outside a scoped deploy's selection.

## Pull without losing local work

By default, `pull` preserves any files you've modified or deleted locally:

```bash
npm run pull -- <org>
# ⏭️  my-assistant (locally changed, skipping)
# ✨  new-tool -> resources/my-org/tools/new-tool.yml
```

Detection works in three layers, so it covers both day-to-day and
fresh-clone workflows:

1. **Content baseline (primary)** — each resource's last-seen platform hash
   lives in the per-developer `.vapi-state-hash/<org>/<uuid>` store
   (gitignored). Comparing local / baseline / dashboard hashes classifies
   every resource as clean, local-ahead (preserved ⬆️), dashboard-ahead
   (synced down ⬇️ — local was unchanged, nothing to lose), or both-diverged
   (gated behind `--resolve=ours|theirs|fail|defer`). See
   [sync behavior](../learnings/sync-behavior.md) for the full matrix.
2. **Git-tracked changes** — when no baseline exists yet, files that show up
   in `git status` (modified, deleted, or individually untracked) are
   preserved.
3. **mtime fallback** — if git can't help (no commits yet, the resource tree
   isn't tracked at all, or git just had nothing to say), files that are
   newer than `.vapi-state.<org>.json` are still preserved. This is the safety
   net for the "fresh clone, edit a file, run pull again" case.

Interactive `npm run pull` is local-first too: it asks
`Overwrite locally modified files?` (default `No`). Pass `--force` (or answer
`Yes`) to overwrite everything with the platform version.

Other ways to pull:

```bash
# Refresh IDs and bindings only, without writing resource files.
npm run pull -- <org> --bootstrap

# Pull one known resource by UUID (--id needs exactly one --type).
npm run pull -- <org> --type squads --id <squad-uuid>
```

`--bootstrap` refreshes `.vapi-state.<org>.json`, credential mappings, and the
generated credential and phone-number block in `.env.<org>`, and leaves
`resources/<org>/` untouched. Setup and ordinary pulls do the same binding
refresh, and `push` runs it automatically when the state looks empty or
stale.

## Test what you deployed

```bash
# Interactive WebSocket call — speak/listen from the terminal.
npm run call -- <org> -a <assistant-name>
npm run call -- <org> -s <squad-name>

# Automated simulation suite against the deployed resource.
npm run sim -- <org> --suite <suite-name> --target <assistant-name>
```

To test changes before they're deployed, on every pull request, see
[PR checks](pr-checks.md).

## Recover from a bad deploy

```bash
# Every push/apply writes a snapshot first. List them:
npm run rollback -- <org> --list

# Re-apply a specific snapshot to undo a deploy:
npm run rollback -- <org> --to <ISO-timestamp>
```

## Clean up platform resources that have no file

```bash
# Dry-run by default — shows what would be deleted, makes no changes.
npm run cleanup -- <org>

# Destructive run — requires explicit confirmation:
npm run cleanup -- <org> --force --confirm <org>
```

Cleanup treats every platform resource that isn't in
`.vapi-state.<org>.json` as an orphan, except those matched by
`resources/<org>/.vapi-ignore`: it lists those as retained and never deletes
them. Still read the dry-run list before a destructive run.

**When the list includes Vapi's built-in fixtures** (for example the stock
simulation personalities, which can't be deleted — see
[simulations](../learnings/simulations.md)), delete the others individually
through the API, then refresh state:

```bash
curl -X DELETE -H "Authorization: Bearer $VAPI_PRIVATE_API_KEY" \
  https://api.vapi.ai/assistant/<orphan-uuid>
npm run pull -- <org> --bootstrap
```

This avoids `--force` stopping at the first built-in resource it can't
delete.

## When to use raw `push` instead of `apply`

Almost never. The only honest case: you just ran `pull`, nothing else has
touched the dashboard since, and you need to skip the merge pass for speed.
In any multi-developer environment, default to `apply`.

If you do use `push`, dry-run it first:

```bash
npm run push -- <org> --dry-run
```

## Pre-flight checklist before any deploy

1. `git status` — uncommitted changes are intentional?
2. `npm run validate -- <org>` — schema clean?
3. `npm run apply -- <org>` (or `apply -- <org> <path>` for a single file)
4. After: verify with `npm run call -- <org> -a <name>` or a `npm run sim` suite
5. If something looks wrong: `npm run rollback -- <org> --list`
