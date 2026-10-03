# Commands

Every command works in two modes:

- **Interactive** — run without arguments, get prompted for org and resources
- **Direct** — pass an org slug and flags for scripting / CI

| Command | Interactive | Direct | One-liner |
| --- | --- | --- | --- |
| `npm run setup` | ✅ | — | First-time org wizard — creates `.env.<org>` and `resources/<org>/`. |
| `npm run validate` | — | `npm run validate -- <org>` | Schema-check local YAML/MD with no network call. **Run before every `apply`.** |
| `npm run audit` | — | `npm run audit -- <org> [--type <t>]` | Read-only drift detector — orphan local YAML, state ghosts, UUID collisions, content-identical clusters, sibling base-slug clusters, dashboard orphans, assistants with inline `model.tools`. Exit 1 on any finding; safe to wire into CI. |
| `npm run promote` | — | `npm run promote -- --pipeline <name> --from <org> --to <org> [--apply]` | Plan or apply a forward-only, dependency-aware promotion defined by `promotion.yml`. |
| `npm run apply` | ✅ | `npm run apply -- <org> [--force]` | **Default deploy verb.** Pull → merge → push in one safe pass; resilient against dashboard drift. |
| `npm run pull` | ✅ | `npm run pull -- <org> [flags]` | Fetch remote state into local files / state file. Local-first by default — won't clobber local edits. |
| `npm run push` | ✅ | `npm run push -- <org> [flags]` | Raw push without a pre-pull. Refuses by default when local YAML files lack state entries (orphan-YAML gate); pass `--allow-new-files` to bypass after confirming intent. **Skip unless you just ran `pull` and are certain state is fresh** — otherwise prefer `apply`. |
| `npm run cleanup` | ✅ | `npm run cleanup -- <org> [--force --confirm <org>]` | Inspect (default) or delete orphaned remote resources. Destructive run requires `--confirm <org>`. |
| `npm run rollback` | — | `npm run rollback -- <org> --list` or `--to <ISO>` | Restore from a snapshot in `.vapi-state.<org>.snapshots/` (one is written before every push/apply). |
| `npm run call` | ✅ | `npm run call -- <org> -a <name>` or `-s <squad>` | Start an interactive WebSocket call against an assistant or squad. |
| `npm run sim` | — | `npm run sim -- <org> --suite <name> --target <name> [--timeout <min>]` | Run a simulation suite (or specific simulations) against a deployed assistant/squad. Prints the run link; exits 0 passed, 1 failed, 3 incomplete (timeout, Ctrl-C, missing results). |
| `npm run check` | — | `npm run check -- <check>\|--all [--dry-run] [--changed-since <ref>] [--budget-minutes <n>] [--json <path>]` | Run the `vapi-checks.yml` simulation checks against the files on disk: each target is built inline (tools, handoffs, judges, personalities; tools mocked fail-closed, servers dead-ended) and run in one simulation run per target, so nothing is deployed. Posts `Vapi Evals` commit statuses when run by the PR workflow. `--dry-run` builds the payloads offline (no key, nothing sent; `--print-payload` writes them). Exits 0 passed, 1 failed, 2 config or build error, 3 incomplete (timeout, interrupt, budget, billing). |
| `npm run migrate` | — | `npm run migrate` | One-time, all orgs at once: slim legacy state files to pure `name → uuid` and seed the per-developer `.vapi-state-hash/` baseline store from the old hashes. Required once after upgrading to the hash-store engine — `pull`/`push`/`apply` refuse legacy-shaped state until it runs. Idempotent. |
| `npm run build` | — | — | Type-check the codebase (`tsc --noEmit`). |
| `npm test` | — | — | Run regression tests (`node:test`). |

## Interactive Mode

When you run a command without arguments, you get a fully interactive experience:

```bash
npm run push
# → Select org (if multiple configured)
# → All resources / Let me pick…
# → Searchable multi-select with git status indicators
# → Confirm and execute

npm run pull
# → Select org
# → All resources / Let me pick…
# → Shows which resources are already local (✔)
# → "Overwrite locally modified files?" — defaults to NO (local-first)
# → Confirm and execute

npm run cleanup
# → Select org
# → Dry-run preview of what would be deleted
# → "Proceed with actual deletion?" — defaults to NO
# → Destructive run is gated by both your confirm AND --confirm <org>
```

Navigation:
- **Type** to search/filter resources
- **Space** to toggle the focused row (or toggle the whole group when the cursor is on a header)
- **Ctrl+A** to select/deselect all currently-visible rows
- **Ctrl+G** to toggle every item in the focused group
- **→ / ←** (right / left arrow) to expand or collapse the focused group
- **Enter** to confirm
- **Esc** to clear the search; press again to step back to the previous prompt

## Direct Mode

Pass an org slug as the first argument to skip interactive prompts:

```bash
# Pull everything for an org
npm run pull -- my-org

# Force pull (overwrite local changes)
npm run pull -- my-org --force

# Push only assistants
npm run push -- my-org assistants

# Push a single file
npm run push -- my-org resources/my-org/assistants/my-agent.md

# Pull with bootstrap (state only, no files written)
npm run pull -- my-org --bootstrap

# Pull a single resource by UUID
npm run pull -- my-org --type assistants --id <uuid>

# Call an assistant
npm run call -- my-org -a my-assistant

# Call a squad
npm run call -- my-org -s my-squad
```
