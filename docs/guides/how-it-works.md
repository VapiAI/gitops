# How the engine works

## One folder per org

Resources are scoped by organization, with names you choose (not fixed `dev`/`stg`/`prod`). Each org gets:

- `.env.<org>` — private API key and base URL
- `.vapi-state.<org>.json` — resource name ↔ UUID mappings (nothing else — committed)
- `.vapi-state-hash/<org>/<uuid>` — last-seen platform content hash per resource, used for drift detection (per-developer, gitignored)
- `resources/<org>/` — all resource files

```
vapi-gitops/
├── .env.my-org                    # Private API key for my-org
├── .env.production                # Private API key for production
├── .vapi-state.my-org.json        # State file for my-org
├── .vapi-state.production.json    # State file for production
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

**`apply`** — runs `pull` then `push` in sequence.

## Conflicts and the drift gate

Conflict handling is **per resource, never umbrella**: apply defaults to `--resolve=defer`, so the pull stage preserves local files and the drift baselines for genuinely conflicted resources, and the push stage then asks one interactive question per conflicted resource (push mine / keep dashboard / save a `.bkp` copy for manual merge). Clean and one-sided changes flow silently in their obvious direction. The full scenario matrix lives in `docs/learnings/sync-behavior.md`. Explicit `--resolve=ours|theirs|fail` keep non-interactive (CI) semantics.

Before updating a resource, push GETs its current dashboard payload, hashes it, and compares against the stored baseline (`.vapi-state-hash/<org>/<uuid>`):

- **Hashes match** → your local edit is the natural next step in the change chain → pushed silently, and the baseline is refreshed from the PATCH **response** (what the platform actually stored).
- **Hashes differ** → someone else published changes since your last sync. In a terminal, push asks **for that resource only**: ① push my local version (take ownership) ② keep the dashboard version (skip, local untouched) ③ save the dashboard version as `<name>.<TIMESTAMP>.bkp.<ext>` beside your file and skip, for a manual merge. In CI / piped runs the resource is blocked instead (use `--overwrite` to push unconditionally).

Backup copies (`*.bkp.*`, gitignored) are merge reference material only — invisible to the loader, the orphan gate, audit, the interactive picker, and explicit CLI paths.

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

Vapi list endpoints cap a response at 100 items and expose no page cursor — only `createdAt` comparison filters. The engine pages backwards through `createdAt` until it gets a short page, so pull, push's invalid-mapping detection, `delete`'s orphan sweep, `audit`, and the credential reverse-map all see the whole type instead of the first hundred. When completeness cannot be proven — an endpoint that ignores the cursor params, a payload with no `createdAt`, or the page-count backstop — the engine says so on stderr. Treat that warning as "do not infer deletion from absence for this type".

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

## Where things live

| Path | What it is |
| --- | --- |
| `resources/<org>/` | Your resources, one folder per org |
| `.vapi-state.<org>.json` | Name → UUID mappings per org (committed) |
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
