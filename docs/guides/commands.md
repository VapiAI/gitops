# Commands

`setup`, `apply`, `pull`, `push`, `cleanup` and `call` work in two modes:

- **Interactive** — run without arguments, get prompted for org and resources
- **Direct** — pass an org name and flags, for scripts and CI

The other commands are direct only.

| Command | Usage | What it does |
| --- | --- | --- |
| `npm run setup` | `npm run setup [-- <org>]` | Connect an org: creates `.env.<org>` and `resources/<org>/`. |
| `npm run validate` | `npm run validate -- <org>` | Check resource files offline. Run it before every `apply`. |
| `npm run apply` | `npm run apply -- <org> [types or paths]` | **The default deploy:** pull, merge, then push. See [workflows](workflows.md). |
| `npm run pull` | `npm run pull -- <org> [--force] [--bootstrap]` | Sync platform changes down; never overwrites local edits unless `--force`. |
| `npm run push` | `npm run push -- <org> [--dry-run]` | Push without pulling first. Prefer `apply`. |
| `npm run rollback` | `npm run rollback -- <org> --list` or `--to <ISO>` | Restore a pre-deploy snapshot from `.vapi-state.<org>.snapshots/`. |
| `npm run cleanup` | `npm run cleanup -- <org> [--force --confirm <org>]` | List platform resources with no file; delete them only with both flags. |
| `npm run audit` | `npm run audit -- <org> [--type <type>]` | Report drift between files, state and the platform. Exits 1 on any finding, so it can run in CI. |
| `npm run call` | `npm run call -- <org> -a <assistant>` or `-s <squad>` | Talk to an assistant or squad from your terminal. |
| `npm run sim` | `npm run sim -- <org> --suite <name> --target <name>` | Run a simulation suite against deployed resources. Exits 0 passed, 1 failed, 3 incomplete. |
| `npm run check` | `npm run check -- <check>` or `--all`, `[--dry-run]` | Run [PR checks](pr-checks.md) against local files, nothing deployed. Exits 0 passed, 1 failed, 2 config or build error, 3 incomplete. |
| `npm run promote` | `npm run promote -- --pipeline <p> --from <org> --to <org> [--apply]` | Plan, or apply, a [promotion](promotion.md) between orgs. |
| `npm run build` | `npm run build` | Type-check the code and tests. |
| `npm test` | `npm test` | Run the test suite. |

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

## Upgrading from an older version

Repositories created before the state-file format changed need a one-time
migration. `pull`, `push` and `apply` refuse to run until it's done:

```bash
npm run migrate
```

It rewrites every org's `.vapi-state.<org>.json` to the current
`{ "name": { "uuid": … } }` format and seeds your local
`.vapi-state-hash/` drift baseline from the old file. It's safe to run more
than once. Commit the rewritten state files.
