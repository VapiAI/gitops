# How the engine works

## One folder per org

Resources are scoped by organization, with names you choose (not fixed `dev`/`stg`/`prod`). Each org gets:

- `.env.<org>` — private API key and base URL
- `resources/<org>/` — all resource files. Hand-written: this is what you edit
- `state/<org>/` — what the engine generates and tracks. Never edit or delete it by hand ([state/README.md](../../state/README.md))
  - `state.json` — resource ID ↔ UUID mappings and optional origin (committed)
  - `org.json` — the Vapi org the folder is pinned to (committed)
  - `local/baselines/<uuid>` — last-seen platform content hash per resource, used for drift detection (per-developer, gitignored)
  - `local/snapshots/` — pre-deploy snapshots for `npm run rollback` (per-developer, gitignored)

```
vapi-gitops/
├── .env.my-org                    # Private API key for my-org
├── .env.production                # Private API key for production
├── state/                         # Written by the engine; don't edit by hand
│   ├── my-org/
│   │   ├── state.json             # Name → UUID mappings for my-org
│   │   ├── org.json               # The Vapi org my-org is pinned to
│   │   └── local/                 # This machine only (gitignored)
│   └── production/
│       └── (same structure)
├── resources/
│   ├── my-org/                    # Dev/test org resources
│   │   ├── assistants/
│   │   ├── tools/
│   │   ├── squads/
│   │   ├── structuredOutputs/
│   │   ├── evals/
│   │   └── simulations/
│   └── production/                # Production org resources
│       └── (same structure)
```

## Sync Workflow

```
pull (default)     pull --force        push
─────────────      ─────────────       ─────────────
Download from      Download from       Upload local
platform, skip     platform, overwrite files to
locally changed    everything          platform
files
```

**`pull`** — downloads platform state. Detects locally modified files and skips them (your work is preserved). Use `--force` to overwrite everything.

**`push`** — reads local files and syncs them to the platform: creates and updates. It deletes platform resources whose files you removed only when you pass `--force`.

**`apply`** — runs `pull` then `push` in sequence. With `--dry-run`, it skips
pull (which writes local files/state) and previews push with read-only GETs.

### Running in CI

Push/apply link preflight reports all blocking files in one **Push stopped**
block and exits **1**, before API mutations, state writes or alias deletion.
"Not linked to any resource in <org> yet" means pushing would create a new
resource; the engine cannot infer new versus renamed/stale intent.

Each file has exact commands: approve `--allow-new-files` for genuinely new
resources, approve `--adopt <id>[=<uuid>]` for a takeover, or merge needed edits
and remove a renamed/stale file. A single ready-to-run combined command appears
only when every file has an unambiguous suggestion; otherwise the report lists
which files need human choice. Suggestions are not authorization to execute.

`--json` on push or apply prints one stdout array of
`{file, resourceType, problem, fix, command}`; ordinary logs go to stderr.
The exit code stays 1 for blockers. `[]` means no link-preflight blockers,
not a guarantee that later network/validation/deployment steps will succeed.
Use `--dry-run --json` for a read-only preview. With npm, use
`npm run -s push -- <org> --dry-run --json` to suppress npm's banner.

Safe, unchanged leftover alias files are removed automatically, including
UUID-suffixed leftovers of an already-adopted mapping on a later plain push.
Edited/unbaselined files need per-file y/N approval in a terminal and stop CI.
The engine never auto-adopts, auto-passes the new-file flag or silently deletes
edited files.

### Names never authorize taking over org resources

Pull keeps existing UUID mappings and filenames stable. An unknown UUID always
gets a separate `<name-slug>-<uuid8>` ID, even if a same-named local file exists.
Neither pull nor push automatically collapses that key onto a local filename.

A file without a state mapping remains subject to the new-file gate. After
confirming it is genuinely new, preview `--dry-run --allow-new-files` and review
the final **Name collisions** list. It compares every planned POST, including
auto-created dependencies, with state and live dashboard names. Matching names
do not change the plan into a takeover. GETs run; platform mutations do not.

To take over a resource intentionally, obtain explicit human approval and use
`--adopt <id>[=<uuid>]`. Adoption links an untracked local file before the gate
and normal PATCH flow. Dependency alias reuse is restricted to state entries
with `origin: pushed` or `origin: adopted`; pulled and legacy entries do not
authorize new name-based links. Existing exact-key legacy links remain intact.

## Conflicts and the drift gate

Conflict handling is **per resource, never umbrella**: apply defaults to `--resolve=defer`, so the pull stage preserves local files and the drift baselines for genuinely conflicted resources, and the push stage then asks one interactive question per conflicted resource (push mine / keep dashboard / save a `.bkp` copy for manual merge). Clean and one-sided changes flow silently in their obvious direction. The full scenario matrix lives in `docs/learnings/sync-behavior.md`. Explicit `--resolve=ours|theirs|fail` keep non-interactive (CI) semantics.

Before updating a resource, push GETs its current dashboard payload, hashes it, and compares against the stored baseline (`state/<org>/local/baselines/<uuid>`):

- **Hashes match** → your local edit is the natural next step in the change chain → pushed silently, and the baseline is refreshed from the PATCH **response** (what the platform actually stored).
- **Hashes differ** → someone else published changes since your last sync. In a terminal, push asks **for that resource only**: ① push my local version (take ownership) ② keep the dashboard version (skip, local untouched) ③ save the dashboard version as `<name>.<TIMESTAMP>.bkp.<ext>` beside your file and skip, for a manual merge. In CI / piped runs the resource is blocked instead (use `--overwrite` to push unconditionally).

Backup copies (`*.bkp.*`, gitignored) are merge reference material only — invisible to the loader, the new-file check, audit, the interactive picker, and explicit CLI paths.

## Reading pull and push output

Distinct semantics in a single pulled-resource line:

| Icon | Meaning |
|------|---------|
| `📝` | Engine wrote/updated a file on disk (clean / no-baseline path) |
| `✨` | Engine created a NEW file on disk (first-time pull of this resource) |
| `✏️`  | Locally modified file detected by git, preserved as-is (no-baseline path) |
| `⬆️`  | `local-ahead` — local has unpushed edits, needs to flow UP to dashboard (preserved) |
| `⬇️`  | Dashboard version flowed DOWN over local: `dashboard-ahead` sync-down (local was unchanged) or `--resolve=theirs` (local edits lost) |
| `⏳` | `--resolve=defer` — 3-way conflict left intact for push's per-resource prompt |
| `🔒` | Platform-default resource (read-only, immutable) |
| `🚫` | Matched `.vapi-ignore` (not tracked locally), or a `.bkp` backup copy refused as a resource |
| `🗑️`  | Locally deleted (deletion intent recorded in state) |

Push adds two more: `⏭️` (conflict prompt → kept dashboard, push skipped) and `📄` (conflict prompt → dashboard copy saved as `<name>.<TIMESTAMP>.bkp.<ext>` for manual merge).

Mental model: `⬆️` flows UP (push), `⬇️` flows DOWN (pull), `📝` is the engine doing routine file I/O.

## Listing completeness

Vapi list endpoints cap a response at 100 items and expose no page cursor — only `createdAt` comparison filters. The engine pages backwards through `createdAt` until it gets a short page, so pull, push's invalid-mapping detection, `delete`'s missing-file sweep, `audit`, and the credential reverse-map all see the whole type instead of the first hundred. When completeness cannot be proven — an endpoint that ignores the cursor params, a payload with no `createdAt`, or the page-count backstop — the engine says so on stderr. Treat that warning as "do not infer deletion from absence for this type".

## Processing Order

**Push** (dependency order): Tools → Structured Outputs → Assistants → Squads → Personalities → Scenarios → Simulations → Simulation Suites → Evals

**Delete** (reverse dependency order): Evals → Simulation Suites → Simulations → ... → Tools

## Reference Resolution

Resource IDs (filenames without extension) are automatically resolved to Vapi UUIDs:

```yaml
# You write:
toolIds:
  - my-tool

# Engine sends to API:
toolIds:
  - "uuid-1234-5678-abcd"
```

## Credential Management

Credentials are managed automatically through the state file. No secrets in resource files or git.

1. **Pull** fetches credentials from Vapi and stores `name → UUID` in the state file
2. Resource files use human-readable credential names
3. **Push** resolves names back to UUIDs before sending to the API

Setup and pull also refresh a marked block in the gitignored `.env.<org>` file:

```dotenv
# BEGIN VAPI MANAGED BINDINGS
VAPI_CREDENTIAL_MY_SERVER_CREDENTIAL=<org-specific-uuid>
VAPI_PHONE_NUMBER_SUPPORT_LINE=<org-specific-uuid>
# END VAPI MANAGED BINDINGS
```

Only IDs are exported. Credentials and phone numbers are never provisioned or
copied between orgs. Phone numbers must have a dashboard name; unnamed or
duplicate-name matches are omitted with a warning. Values maintained outside
the marked block are preserved and take precedence.

```yaml
# Resource file (environment-agnostic)
server:
  credentialId: my-server-credential

# State file (environment-specific)
# "credentials": { "my-server-credential": { "uuid": "2f6db611-ad08-4099-8bd8-74db37b0a07e" } }
```

## State File

Tracks resource ID ↔ Vapi UUID mappings per org:

```json
{
  "assistants": { "my-assistant": { "uuid": "9c0f3f42-…" } },
  "credentials": { "my-cred": { "uuid": "2f6db611-…" } },
  "squads": { "my-squad": { "uuid": "51a9e1c7-…" } },
  "tools": { "my-tool": { "uuid": "d4b8a2e0-…" } }
}
```

Every resource type has a section. Keys are sorted, so diffs stay readable.
New entries record `origin: pushed`, `pulled`, or `adopted`. Updates preserve
that provenance, and legacy entries without an origin are not backfilled.

## What Vapi sees

Every API request uses the org's private key and identifies the tool with a
User-Agent: `vapi-gitops-<command>/<version>`, where `<command>` is the gitops
command you ran (`apply`, `push`, `pull`, …; `cli` if it can't be told). It
adds ` (ci)` when `GITHUB_ACTIONS=true` or `CI` is set to anything other than
`false` or `0`. For example, `npm run apply` in a GitHub workflow sends
`vapi-gitops-apply/1.0.0 (ci)`. Your own npm script names are never sent.

Each request also sends an `x-vapi-client` header with the same details plus a
run id: `gitops/<version>; command=<command>; run=<run id>[; ci]`. The run id is
a random UUID made once per command you run and shared by every process it
starts, so Vapi can group one run's requests. It identifies nothing about you
or your machine.

Vapi uses these headers to count how the tool is used. Nothing else is sent beyond the
requests themselves; there is no separate telemetry.

## Where things live

| Path | What it is |
| --- | --- |
| `resources/<org>/` | Your resources, one folder per org |
| `state/<org>/` | What the engine generates and tracks: name → UUID mappings and the org pin (committed), plus `local/` (gitignored). Not edited by hand |
| `.env.<org>` | API key and generated binding IDs (gitignored) |
| `promotion.yml`, `vapi-checks.yml` | Promotion pipelines and PR checks (copy from the `*.example.yml` files) |
| `resources/<org>/.vapi-ignore` | Platform resources this repo shouldn't manage (see `resources/.vapi-ignore.example`) |
| `src/` | The engine; `package.json` scripts name each command's entry point |
| `tests/` | The test suite (`npm test`) |
| `docs/guides/` | These guides |
| `docs/learnings/` | The Vapi field guide |
| `docs/changelog.md` | A template for your own deployment's change log |
| `examples/` | Copyable examples; never loaded by the engine |
| `.github/workflows/` | CI, PR checks and promotion workflows |
| `AGENTS.md`, `CLAUDE.md` | Instructions for coding agents |
