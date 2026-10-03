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
