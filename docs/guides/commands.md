# Commands

`setup`, `apply`, `pull`, `push`, `cleanup` and `call` work in two modes:

- **Interactive** — run without arguments, get prompted for org and resources
- **Direct** — pass an org name and flags, for scripts and CI

The other commands are direct only.

| Command | Usage | What it does |
| --- | --- | --- |
| `npm run setup` | `npm run setup [-- <org>]` | Connect an org: creates `.env.<org>` and `resources/<org>/`. |
| `npm run validate` | `npm run validate -- <org>` | Check resource files offline: API shape rules, and that every reference names a file or a state entry. `apply` runs it first. On GitHub Actions, findings are also shown on the files in the pull request. |
| `npm run apply` | `npm run apply -- <org> [types or paths]` | **The default deploy:** pull, merge, then push. See [workflows](workflows.md). |
| `npm run pull` | `npm run pull -- <org> [--force] [--bootstrap]` | Sync platform changes down; never overwrites local edits unless `--force`. |
| `npm run push` | `npm run push -- <org> [--dry-run] [--strict]` | Push without pulling first. Prefer `apply`. `--strict` aborts before any API call if validation finds an error. |
| `npm run rollback` | `npm run rollback -- <org> --list` or `--to <ISO>` | Restore a pre-deploy snapshot from `state/<org>/local/snapshots/`. |
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

Upgrading the engine does not change where your state is kept. A repository
with `.vapi-state.<org>.json` at its root keeps it there: `pull`, `push`,
`apply` and `promote` read and write it in place, on your machine and in CI,
for as long as you like. Each of those commands prints one line saying the
newer layout exists.

`npm run migrate` is the only command that moves state. It needs no org and
no API key, and it's safe to run more than once:

```bash
npm run migrate
git add -A -- state ':(glob).vapi-state.*.json' resources
git commit -m "chore: move engine state into state/"
```

It does three things.

**Says what your commit step has to stage, before it moves anything.** A
promotion or apply run in CI writes the state file and leaves committing it
to a later step. If that step stages only the old file, moved state drops out
of git: every run still passes, and the next one creates every resource
again. Once state is in `state/`, whatever commits state after a run has to
stage both of these:

```bash
git add -A -- state                          # the new folder
git add -A -- ':(glob).vapi-state.*.json'    # the old files, so their removal is committed
```

A commit action or a script needs the same two paths. Upstream's
`.github/workflows/promotion.yml` has both.

**Moves engine files into `state/<org>/`,** when it can see that step or you
tell it. Nothing changes inside the files.

| Before | Now |
| --- | --- |
| `.vapi-state.<org>.json` | `state/<org>/state.json` |
| `resources/<org>/.vapi-org.json` | `state/<org>/org.json` |
| `.vapi-state-hash/<org>/` | `state/<org>/local/baselines/` |
| `.vapi-state.<org>.snapshots/` | `state/<org>/local/snapshots/` |

What it does depends on what it reads in `.github/workflows/`:

- **Every commit step there stages `state/`.** It moves every org.
- **A step stages `.vapi-state.*.json` and nothing that could be `state/`.**
  It moves nothing and names the workflow. Take upstream's `promotion.yml`
  workflow, or add `git add -A -- state` to your own commit step, then run
  `npm run migrate` again.
- **Anything else.** A step that stages through a script, a commit action or
  a variable, a repository with no workflow, or a pipeline in another CI
  system. It moves nothing and asks you. When your step stages both paths,
  say so:

  ```bash
  npm run migrate -- --commit-step-stages-state
  ```

  That writes `state/commit-step.json` and moves every org. Commit it with
  the move.

> **`--commit-step-stages-state` is your word, and the engine can't check
> it.** If you pass it and your commit step does not stage `state/`,
> promotion runs pass while `state/<org>/state.json` is never committed, and
> a later run creates the same resources again. The flag is refused only when
> a workflow is plainly seen to stage the old file alone. To take it back,
> delete `state/commit-step.json`.

**Rewrites a legacy-format state file.** Repositories created before the
state-file format changed carry per-resource hashes in the state file, and
`pull`, `push` and `apply` refuse to run until they're gone. `migrate`
rewrites each file to the current `{ "name": { "uuid": … } }` format and
seeds this machine's drift baselines from the old file.

### What the engine reads as a commit step

The engine reads the workflow files in `.github/workflows/` and nothing else.
It counts a `git add` as staging `state/` only where it can tell what the
command stages:

- It is a command of its own in a `run:` step that runs `bash` or `sh` at
  the repository root.
- It names `state` (also `state/` or `state/**`), or it stages everything:
  `git add -A`, `git add --all`, `git add .`.
- An `if` around it is fine when it names `state`, because that is how a step
  guards a folder that may not exist yet.

Everything else counts for nothing: a `git add` after a `cd`, in a step with
a `working-directory`, after `||`, inside a loop, a function or a quoted
string, with `-u`, with a variable or an exclusion in its paths, or a
`git add -A` inside an `if`. A step like that may well work. The engine just
can't tell, so `migrate` asks for the flag.

Every job that shows a commit step has to pass, in every workflow file. A job
shows none when its `permissions` keep `contents` read-only and it runs no
`git add`, `git commit` or `git push`, so upstream's `ci.yml` and
`vapi-checks.yml` don't get in the way.

A pipeline the engine has no file for is never read: another CI system, or a
script that commits with its own token. Check it yourself against the two
lines above before you run `migrate`.

### When a CI run stops

A CI run stops, before it sends any request, when the workflow running it is
seen not to commit what it would write:

- State is in `state/`, and the commit step stages only the old file.
- State is in `state/`, the commit step can't be read, and there is no
  `state/commit-step.json`.
- State is still at the root, and the commit step stages only `state/`.

In GitHub Actions the engine checks the workflow that is running it. Anywhere
else it checks every workflow in the repository.

If both the old and the new file exist for an org and they disagree, every
writing command stops before it changes anything and names the two files. If
they hold the same content, the engine reads the one in `state/`, keeps the
old copy identical, and says that `npm run migrate` removes it.

### What you'll see after upgrading

- **`ℹ️  Engine state here is in the older layout …`**, one line per writing
  command, until you run `npm run migrate`. Nothing else changes.

After `npm run migrate`:

- **`📦 Moved … into state/<org>/`**, once per org, from `migrate` itself.
- **`📦 1 locally modified file(s) will be preserved`** on a `pull` before you
  commit the move. The file is the old org pin,
  `resources/<org>/.vapi-org.json`. It moved to `state/<org>/org.json`, so git
  shows it as deleted until you commit. Pull does nothing differently because
  of it.
- **`📦 Moved .vapi-state-hash/<org>/ … into state/<org>/local/`**, once, on
  each teammate's machine after they pull your commit. Those are that
  machine's own baselines and snapshots, which are not in git.

### Going back to an older engine

A repository that never ran `npm run migrate` has nothing to move back: its
state is where an older engine looks for it.

An engine from before `state/` doesn't read the folder. If you revert the
engine after state has moved, it finds no state file: `pull` adopts every
resource again under a new file name, and promotion creates each resource a
second time. Move the state files back first, in the same commit as the
revert:

```bash
for dir in state/*/; do
  org=$(basename "$dir")
  if [ -f "state/$org/state.json" ]; then mv "state/$org/state.json" ".vapi-state.$org.json"; fi
  if [ -f "state/$org/org.json" ]; then mv "state/$org/org.json" "resources/$org/.vapi-org.json"; fi
  # This machine's baselines and snapshots. They are not in git, so everyone
  # who has pulled or pushed since the move runs these two on their machine.
  if [ -d "state/$org/local/baselines" ]; then mkdir -p .vapi-state-hash && mv "state/$org/local/baselines" ".vapi-state-hash/$org"; fi
  if [ -d "state/$org/local/snapshots" ]; then mv "state/$org/local/snapshots" ".vapi-state.$org.snapshots"; fi
done
git add -A -- state ':(glob).vapi-state.*.json' resources
```

Then revert the engine and commit. The older engine ignores whatever is left
under `state/`. A commit step that was changed to stage only `state/` has to
stage `.vapi-state.*.json` again.
