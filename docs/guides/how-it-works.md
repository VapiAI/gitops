# How the engine works

## Organization-Based Structure

Resources are scoped by organization (not fixed `dev`/`stg`/`prod` names). Each org gets:

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

**`push`** — reads local files and syncs them to the platform. Handles creates, updates, and deletions.

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

## Project Structure

```
vapi-gitops/
├── docs/
│   ├── Vapi Prompt Optimization Guide.md
│   ├── changelog.md
│   └── learnings/                      # Gotchas, recipes, troubleshooting per area
│       ├── assistants.md
│       ├── tools.md
│       ├── squads.md
│       ├── simulations.md
│       └── ...
├── src/
│   ├── setup.ts               # Setup wizard (interactive) + non-interactive setup
│   ├── setup-args.ts          # `npm run setup` argument parsing
│   ├── interactive.ts          # Interactive pull/push/apply/call/cleanup flows
│   ├── searchableCheckbox.ts   # Custom multi-select prompt component
│   ├── pull.ts                 # Pull platform state
│   ├── push.ts                 # Push local state to platform
│   ├── apply.ts                # Orchestrator: pull → merge → push
│   ├── call.ts                 # WebSocket call script
│   ├── cleanup.ts              # Orphan cleanup
│   ├── pull-cmd.ts             # Entry point: interactive or direct pull
│   ├── push-cmd.ts             # Entry point: interactive or direct push
│   ├── apply-cmd.ts            # Entry point: interactive or direct apply
│   ├── call-cmd.ts             # Entry point: interactive or direct call
│   ├── cleanup-cmd.ts          # Entry point: interactive or direct cleanup
│   ├── types.ts                # TypeScript interfaces
│   ├── config.ts               # Environment & configuration
│   ├── api.ts                  # Vapi HTTP client
│   ├── state.ts                # State file management
│   ├── resources.ts            # Resource loading (YAML, MD, TS)
│   ├── resolver.ts             # Reference resolution
│   ├── credentials.ts          # Credential resolution (name ↔ UUID)
│   ├── delete.ts               # Deletion & orphan checks
│   └── check-cmd.ts            # Entry point: PR simulation checks (check-*.ts)
├── resources/
│   └── <org>/                  # One directory per configured org
│       ├── assistants/
│       ├── tools/
│       ├── squads/
│       ├── structuredOutputs/
│       ├── evals/
│       └── simulations/
│           ├── personalities/
│           ├── scenarios/
│           ├── tests/
│           └── suites/
├── tests/
│   ├── credentials.test.ts     # Credential walker scoping (P0-1 regression suite)
│   ├── clean-resource.test.ts  # null-preservation in pull (P0-3 regression suite)
│   ├── path-matching.test.ts   # Short-form path matching (P0-7 regression suite)
│   ├── cleanup-safety.test.ts  # --confirm + empty-state gates (P0-4 regression suite)
│   └── cli-arg-parsing.test.ts # Bare-id refusal, --confirm pass-through (P0-7)
├── vapi-checks.example.yml     # Copy to vapi-checks.yml for PR simulation checks
├── .env.<org>                  # Private API key per org (gitignored)
└── .vapi-state.<org>.json      # State file per org
```
