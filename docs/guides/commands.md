# Commands

`setup`, `apply`, `pull`, `push`, `cleanup` and `call` work in two modes:

- **Interactive** — run without arguments, get prompted for org and resources
- **Direct** — pass an org name and flags, for scripts and CI

The other commands are direct only.

| Command | Usage | What it does |
| --- | --- | --- |
| `npm run setup` | `npm run setup [-- <org>]` | Connect an org: creates `.env.<org>` and `resources/<org>/`. |
| `npm run validate` | `npm run validate -- <org>` | Check resource files offline: API shape rules, and that every reference names a file or a state entry. `apply` runs it first. On GitHub Actions, findings are also shown on the files in the pull request. |
| `npm run apply` | `npm run apply -- <org> [types or paths] [--adopt <id>[=<uuid>]]` | **The default deploy:** pull, merge, then push. See [workflows](workflows.md). |
| `npm run pull` | `npm run pull -- <org> [--force] [--bootstrap]` | Sync platform changes down; never overwrites local edits unless `--force`. |
| `npm run push` | `npm run push -- <org> [--dry-run] [--json] [--strict] [--adopt <id>[=<uuid>]]` | Push without pulling first. Prefer `apply`. `--strict` aborts before any API call if validation finds an error. |
| `npm run rollback` | `npm run rollback -- <org> --list` or `--to <ISO>` | Restore a pre-deploy snapshot from `.vapi-state.<org>.snapshots/`. |
| `npm run cleanup` | `npm run cleanup -- <org> [--force --confirm <org>]` | List platform resources with no file; delete them only with both flags. |
| `npm run audit` | `npm run audit -- <org> [--type <type>]` | Report drift between files, state and the platform. Exits 1 on any finding, so it can run in CI. |
| `npm run call` | `npm run call -- <org> -a <assistant>` or `-s <squad>` | Talk to an assistant or squad from your terminal. |
| `npm run sim` | `npm run sim -- <org> --suite <name> --target <name>` | Run a simulation suite against deployed resources. Exits 0 passed, 1 failed, 3 incomplete. |
| `npm run check` | `npm run check -- <check>` or `--all`, `[--dry-run]` | Run [PR checks](pr-checks.md) against local files, nothing deployed. Exits 0 passed, 1 failed, 2 config or build error, 3 incomplete. |
| `npm run promote` | `npm run promote -- --pipeline <p> --from <org> --to <org> [--apply]` | Plan, or apply, a [promotion](promotion.md) between orgs. |
| `npm run build` | `npm run build` | Type-check the code and tests. |
| `npm test` | `npm test` | Run the test suite. |

Pull and push never automatically rename UUID-suffixed state keys to match
local files. A local file without a UUID mapping remains subject to the
new-file gate even if the org has a same-name resource. The gate reports
same-name candidates without linking them. Existing mappings, including
legacy entries without provenance, remain linked. New pull mappings record
`origin: pulled`; push-created resources record `origin: pushed`.

Dry-run push/apply ends with **Name collisions**, listing same-name state and
live dashboard resources for every planned POST, including dependency creates.
Read-only GETs run in dry-run. No matches prints `Name collisions: none`;
unavailable inventories are reported as an incomplete check, not a clean result.
Check this list before deploying; taking over a resource requires explicit
human approval for `--adopt`, just as `--allow-new-files` requires approval.

### Running in CI

Push/apply link preflight reports all blocking files in one **Push stopped**
block and exits **1**, before API mutations, state writes or alias deletion.
"Not linked to any resource in <org> yet" means pushing would create a new
resource; the engine cannot infer new versus renamed/stale intent.

The same check covers dependencies a scoped push would auto-create: tools,
structured outputs, and squad member assistants (including their dependencies).
They are marked "Needed by <selected file>" in text and in JSON's `problem`
field. Already-linked dependencies and repo-owned mappings that can be safely
reused do not require creation approval. `--allow-new-files` authorizes new
resources across the selected scope **and its dependencies**; you do not need
to list the dependency paths separately. For example, after reviewing the
whole plan:

```bash
npm run push -- <org> assistants/receptionist.md --allow-new-files
# Or explicitly take over the existing tool instead of creating one:
npm run push -- <org> assistants/receptionist.md --adopt my-end-call
```

Without either approval, an unlinked dependency stops the run with exit 1
before API mutations or state writes. `--dry-run` reports the same blockers
and never creates resources.

Each file has exact commands: approve `--allow-new-files` for genuinely new
resources, approve `--adopt <id>[=<uuid>]` for a takeover, or merge needed edits
and remove a renamed/stale file. A single ready-to-run combined command appears
only when every file has an unambiguous suggestion; otherwise the report lists
which files need human choice. Suggestions are not authorization to execute.

`--json` on push or apply prints one stdout array of
`{file, resourceType, problem, fix, command}`; ordinary logs go to stderr.
The exit code stays 1 for blockers. `[]` means no link-preflight blockers,
not a guarantee that later network/validation/deployment steps will succeed.
Use `--dry-run --json` for a read-only preview. When invoking through npm,
use `npm run -s push -- <org> --dry-run --json` to suppress npm's own
command banner on stdout.

Safe, unchanged leftover alias files are removed automatically, including
UUID-suffixed leftovers of an already-adopted mapping on a later plain push.
Edited/unbaselined files need per-file y/N approval in a terminal and stop CI.
The engine never auto-adopts, auto-passes the new-file flag or silently deletes
edited files.

### Explicit resource adoption

`--adopt <resourceId>` opts a local file into taking over an existing org
resource. It is repeatable; `--adopt=<resourceId>` also works. The file must
exist and have no state mapping. Candidates are same-base-slug state entries
and live resources of that type matching the file's name (or ID when unnamed).
One distinct candidate is required. If several exist, use
`--adopt <resourceId>=<uuid>`; that UUID must exist remotely for the file's type.
Missing files, already-linked files, and zero/ambiguous candidates are errors.

Adoption records `origin: adopted`, removes other state keys for that UUID, and
uses the normal PATCH path. Scoped saves include both sides of the re-key.
`--dry-run --adopt <id>` performs live GET lookups and prints
`would adopt <id> → <uuid>`, but does not write state or mutate the platform.
`apply` forwards adoption to its push stage; its preceding pull remains a
normal pull except in `--dry-run`, which skips pull to avoid local writes.
Adoption deletes leftover alias files only when they match the last-synced
baseline. Edited files or missing baselines need per-file y/N approval in a
terminal; headless runs stop before changing files, state or the platform.
Merge those edits into the adopted file or delete the alias manually and rerun.
Dry-run reports would-delete/would-fail without deleting. Baselines are keyed
by remote UUID, not alias; adoption drops the shared old baseline and the normal
PATCH records a fresh one for the adopted resource.

Dependencies are automatically reused by name only when an existing state
entry records `origin: pushed` or `origin: adopted`. Pulled and legacy entries,
and dashboard-only name matches, are not authorization: a missing dependency
is POST-created with a warning naming the existing resources. Use explicit
adoption before dependency resolution to take one over instead.

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

## Test calls (`npm run call`)

The test-call CLI cleans its terminal output for the developer loop:

- **Coalesced transcripts.** Chunked TTS providers (Cartesia Sonic, etc.) stream each utterance as 2–4 separate `final` transcript events. The CLI buffers consecutive finals from the same role and flushes them as one merged `🤖 Assistant:` / `🎤 You:` line after a 600 ms quiet window, on role change, on `speech-update` from the opposite role, on `call-ended`, and on Ctrl+C. To see every raw fragment (for a transcriber or TTS investigation), lower `COALESCE_TIMEOUT_MS` in `src/call.ts`.
- **Suppressed `mpg123` warnings.** macOS speaker output emits `Didn't have any audio data in callback (buffer underflow)` lines from native code on every chunk-boundary gap. The `npm run call` script wraps invocation in `bash -c` + a stderr filter that drops these lines so they no longer dominate the log. Requires `bash` on `PATH` (universal on macOS, Linux, WSL).
- **Tool / handoff / status visibility.** The CLI surfaces previously-dropped WebSocket control messages:
  - `🔧 Tool call: <name>(<args>)` — regular tool invocations
  - `🔀 Handoff → <Target Name>` — squad handoffs (detected from `handoff_to_<Target_Name>` function names)
  - `✅ Tool result: <name> → <preview>` / `❌ Tool failed: <name> → <preview>` — tool responses, truncated to 200 chars
  - `📞 Status: <state>[+reason]` — `in-progress`, `forwarding`, `ended`
  - `⚠️ Hang warning` — impending termination
  - `🔀 Transfer → <destination>` — number / SIP / cross-assistant transfers
- **Discovery mode.** Set `VAPI_CALL_DEBUG=1` in the environment to log unknown control message types (high-frequency events like `conversation-update`, `model-output`, `function-call`, `user-interrupted` are silently dropped by default to keep the log readable):

  ```bash
  VAPI_CALL_DEBUG=1 npm run call -- <org> -s <squad>
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
