# Vapi GitOps

Manage Vapi resources via Git using YAML/Markdown as the source-of-truth.

## Why GitOps?

|                       | Dashboard / Ad-hoc API                                          | GitOps                                     |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| **History**           | Limited visibility of who changed what                          | Full git history with blame                |
| **Review**            | Changes go live immediately (can break things)                  | PR review before deploy                    |
| **Rollback**          | Manual recreation                                               | `git revert` + push                        |
| **Environments**      | Tedious to copy-paste between envs                              | Same config, different state files         |
| **Collaboration**     | One person at a time. Need to duplicate assistants, tools, etc. | Team can collaborate and use git branching |
| **Reproducibility**   | "It worked on my assistant!"                                    | Declarative, version-controlled            |
| **Disaster Recovery** | Hope you have backups                                           | Re-apply from git                          |

### Supported Resources

| Resource               | Status | Format                               |
| ---------------------- | ------ | ------------------------------------ |
| **Assistants**         | ✅     | `.md` (with system prompt) or `.yml` |
| **Tools**              | ✅     | `.yml`                               |
| **Structured Outputs** | ✅     | `.yml`                               |
| **Squads**             | ✅     | `.yml`                               |
| **Personalities**      | ✅     | `.yml`                               |
| **Scenarios**          | ✅     | `.yml`                               |
| **Simulations**        | ✅     | `.yml`                               |
| **Simulation Suites**  | ✅     | `.yml`                               |
| **Evals**              | ✅     | `.yml`                               |

---

## Quick Start

### Prerequisites

- Node.js installed
- Vapi API token

### Installation

```bash
npm install
```

### Interactive Setup

The easiest way to get started is the interactive setup wizard:

```bash
npm run setup
```

This will:

1. Prompt for your Vapi API key (with region auto-detection)
2. Ask for an org/folder name (e.g. `my-org`, `production`)
3. Let you choose which resources to download (all or pick individually)
4. Detect dependencies and offer to download them too
5. Create `.env.<org>` and `resources/<org>/` for you

You can run setup multiple times to add more orgs.

### Commands

Every command works in two modes:

- **Interactive** — run without arguments, get prompted for org and resources
- **Direct** — pass an org slug and flags for scripting / CI

| Command | Interactive | Direct | Description |
| --- | --- | --- | --- |
| `npm run setup` | ✅ | — | First-time org setup wizard |
| `npm run pull` | ✅ | `npm run pull -- <org> [flags]` | Pull remote resources locally |
| `npm run push` | ✅ | `npm run push -- <org> [flags]` | Push local resources to Vapi |
| `npm run apply` | ✅ | `npm run apply -- <org> [--force]` | Pull → Merge → Push in one shot |
| `npm run call` | ✅ | `npm run call -- <org> -a <name>` | Start a WebSocket call |
| `npm run cleanup` | ✅ | `npm run cleanup -- <org> [--force --confirm <org>]` | Delete orphaned remote resources (destructive run requires `--confirm <org>`) |
| `npm run eval` | — | `npm run eval -- <org> -s <squad>` | Run evals against an assistant/squad |
| `npm run mock:webhook` | — | — | Local webhook receiver for testing |
| `npm run build` | — | — | Type-check the codebase |
| `npm test` | — | — | Run regression tests (`node:test`) |

### Interactive Mode

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

### Direct Mode

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

# Run evals
npm run eval -- my-org -s my-squad
npm run eval -- my-org -a my-assistant --filter booking
```

---

## Organization-Based Structure

Resources are scoped by organization (not fixed `dev`/`stg`/`prod` names). Each org gets:

- `.env.<org>` — API token and base URL
- `.vapi-state.<org>.json` — resource ID ↔ UUID mappings
- `resources/<org>/` — all resource files

```
vapi-gitops/
├── .env.my-org                    # API token for my-org
├── .env.production                # API token for production
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

### Promoting Resources Across Orgs

```bash
# Copy a squad from dev to production
cp resources/my-org/squads/voice-squad.yml resources/production/squads/
cp resources/my-org/assistants/intake-agent.md resources/production/assistants/

# Push to production (missing dependencies auto-resolve)
npm run push -- production
```

---

## How to Use This Repo

1. **Run `npm run setup`** to configure your first org
2. **Edit resources** in `resources/<org>/` (`.md` assistants, `.yml` tools/squads/etc.)
3. **Push changes** with `npm run push` (interactive) or `npm run push -- <org>`
4. **Pull updates** with `npm run pull` when the platform may have changed

Use:

- `pull` when Vapi might have changed
- `push` for explicit deploys
- `apply` (`pull -> merge -> push`) for sync + deploy in one command

### Bootstrap State Sync

Use bootstrap pull when you need the latest platform IDs and credential mappings without downloading all remote resources:

```bash
npm run pull -- my-org --bootstrap
```

This refreshes `.vapi-state.<org>.json` and credential mappings while leaving `resources/<org>/` untouched. If you skip this step, `push` will automatically run it when it detects empty or stale state.

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

Detection works in two layers, so it covers both day-to-day and fresh-clone
workflows:

1. **Git-tracked changes** — files that show up in `git status` (modified,
   deleted, or individually untracked) are preserved.
2. **mtime fallback** — if git can't help (no commits yet, the resource tree
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

### Running Evals

Evals run mock conversations against an assistant or squad and check assertions.

```bash
# Run all evals against a squad (transient — loaded from local files)
npm run eval -- my-org -s my-squad

# Run a specific eval by name filter
npm run eval -- my-org -a my-assistant --filter booking

# Use stored assistant/squad IDs from state (already pushed)
npm run eval -- my-org -s my-squad --stored

# Load assistant from a specific file path
npm run eval -- my-org -a resources/my-org/assistants/qa-tester.md

# Provide variable overrides
npm run eval -- my-org -s my-squad -v eval-variables.json
```

Evals must be pushed first (`npm run push -- my-org evals`). Eval definitions live in `resources/<org>/evals/*.yml`.

### Webhook Local Testing

```bash
# 1) Run local receiver
npm run mock:webhook

# 2) Expose localhost
ngrok http 8787
```

Set your assistant's `server.url` to the ngrok HTTPS URL.

---

## File Formats

### Assistants with System Prompts (`.md`)

Markdown with YAML frontmatter — the system prompt is readable Markdown below the config:

```markdown
---
name: My Assistant
voice:
  provider: 11labs
  voiceId: abc123
model:
  model: gpt-4.1
  provider: openai
  toolIds:
    - my-tool
firstMessage: Hello! How can I help you?
---

# Identity & Purpose

You are a helpful assistant for the business you represent.

# Conversation Flow

1. Greet the user
2. Ask how you can help
3. Resolve their issue

# Rules

- Always be polite
- Never make up information
```

### Tools (`.yml`)

```yaml
type: function
function:
  name: get_weather
  description: Get the current weather for a location
  parameters:
    type: object
    properties:
      location:
        type: string
        description: The city name
    required:
      - location
server:
  url: https://my-api.com/weather
```

### Structured Outputs (`.yml`)

```yaml
name: Call Summary
type: ai
description: Summarizes the key points of a call
schema:
  type: object
  properties:
    summary:
      type: string
    sentiment:
      type: string
      enum: [positive, neutral, negative]
assistant_ids:
  - my-assistant
```

### Squads (`.yml`)

```yaml
name: Support Squad
members:
  - assistantId: intake-agent
    assistantDestinations:
      - type: assistant
        assistantId: specialist-agent
        message: Transferring you to a specialist.
  - assistantId: specialist-agent
```

### Evals (`.yml`)

```yaml
name: Booking Happy Path
type: eval
# (eval config as per Vapi API)
```

### Simulations

**Personality** (`simulations/personalities/`):

```yaml
name: Skeptical Sam
description: A doubtful caller who questions everything
prompt: You are skeptical and need convincing before trusting information.
```

**Scenario** (`simulations/scenarios/`):

```yaml
name: Happy Path - New Customer
description: New customer calling to schedule an appointment
prompt: |
  You are a new customer calling to schedule your first appointment.
```

**Simulation** (`simulations/tests/`):

```yaml
name: Booking Test Case 1
personalityId: skeptical-sam
scenarioId: happy-path-new-customer
```

**Simulation Suite** (`simulations/suites/`):

```yaml
name: Booking Flow Tests
simulationIds:
  - booking-test-case-1
  - booking-test-case-2
```

---

## How the Engine Works

### Sync Workflow

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

### Processing Order

**Push** (dependency order): Tools → Structured Outputs → Assistants → Squads → Personalities → Scenarios → Simulations → Simulation Suites → Evals

**Delete** (reverse dependency order): Evals → Simulation Suites → Simulations → ... → Tools

### Reference Resolution

Resource IDs (filenames without extension) are automatically resolved to Vapi UUIDs:

```yaml
# You write:
toolIds:
  - my-tool

# Engine sends to API:
toolIds:
  - "uuid-1234-5678-abcd"
```

### Credential Management

Credentials are managed automatically through the state file. No secrets in resource files or git.

1. **Pull** fetches credentials from Vapi and stores `name → UUID` in the state file
2. Resource files use human-readable credential names
3. **Push** resolves names back to UUIDs before sending to the API

```yaml
# Resource file (environment-agnostic)
server:
  credentialId: my-server-credential

# State file (environment-specific)
# "my-server-credential": "2f6db611-ad08-4099-8bd8-74db37b0a07e"
```

### State File

Tracks resource ID ↔ Vapi UUID mappings per org:

```json
{
  "credentials": { "my-cred": "uuid-0000" },
  "tools": { "my-tool": "uuid-1234" },
  "assistants": { "my-assistant": "uuid-5678" },
  "squads": { "my-squad": "uuid-abcd" },
  "evals": { "booking-happy-path": "uuid-efgh" }
}
```

---

## Project Structure

```
vapi-gitops/
├── docs/
│   ├── Vapi Prompt Optimization Guide.md
<<<<<<< HEAD
│   └── changelog.md
=======
│   ├── changelog.md
│   └── learnings/                      # Gotchas, recipes, troubleshooting per area
│       ├── assistants.md
│       ├── tools.md
│       ├── squads.md
│       ├── simulations.md
│       └── ...
>>>>>>> e280ea5 (docs: align README and AGENTS with org-slug model and P0 fixes)
├── src/
│   ├── setup.ts               # Interactive setup wizard
│   ├── interactive.ts          # Interactive pull/push/apply/call/cleanup flows
│   ├── searchableCheckbox.ts   # Custom multi-select prompt component
│   ├── pull.ts                 # Pull platform state
│   ├── push.ts                 # Push local state to platform
│   ├── apply.ts                # Orchestrator: pull → merge → push
│   ├── call.ts                 # WebSocket call script
│   ├── eval.ts                 # Eval runner
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
│   └── delete.ts               # Deletion & orphan checks
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
├── scripts/
│   └── mock-vapi-webhook-server.ts
├── .env.<org>                  # API token per org (gitignored)
└── .vapi-state.<org>.json      # State file per org
```

---

## Configuration

### Environment Variables

| Variable        | Required | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `VAPI_TOKEN`    | ✅       | API authentication token                         |
| `VAPI_BASE_URL` | ❌       | API base URL (defaults to `https://api.vapi.ai`) |

These are stored in `.env.<org>` files, one per configured organization.

---

## Troubleshooting

### "Reference not found" warnings

The referenced resource doesn't exist. Check:

1. File exists in correct folder
2. Filename matches exactly (case-sensitive)
3. Using filename without extension
4. For nested resources, use full path (`folder/resource`)

### "Cannot delete resource - still referenced"

1. Find which resources reference it (shown in error)
2. Remove the references
3. Push again
4. Then delete the resource file

### Resource not updating

Check the state file has correct UUID:

1. Open `.vapi-state.<org>.json`
2. Find the resource entry
3. If incorrect, delete entry and re-run push

### "Credential with ID not found" errors

The credential UUID doesn't exist in the target org. Fix:

1. Run `npm run pull -- <org>` to fetch credentials into the state file
2. If the credential doesn't exist, create it in the Vapi dashboard with the same name
3. Pull again — the mapping will be auto-populated

### "property X should not exist" API errors

Some properties can't be updated after creation. Add them to `UPDATE_EXCLUDED_KEYS` in `src/config.ts`.

### "Refusing to run destructive cleanup" errors

`npm run cleanup` is intentionally double-gated for destructive runs:

- `--force` alone is not enough — you also have to name the org with
  `--confirm <org>`. This catches the common mistake of copy-pasting `--force`
  from another command where it had a different meaning.
- An empty state file (zero tracked resources) is refused even with both
  flags. This prevents a fresh clone or a corrupted state from being misread
  as "all remote resources are orphaned" and wiping the org.

```bash
# Wrong — refused
npm run cleanup -- my-org --force

# Right — destructive run
npm run cleanup -- my-org --force --confirm my-org

# Bootstrapping into an empty state? Pull first.
npm run pull -- my-org --bootstrap
```

The interactive `npm run cleanup` flow handles both gates for you (it shows
the dry-run preview, asks you to confirm, and forwards `--force --confirm
<org>` automatically when you say yes).

### "Unrecognized argument" / push appears to do nothing

If you typed `npm run push -- my-org foo` (a bare resource id with no folder
or extension), the CLI now refuses with `Unrecognized argument: foo` rather
than silently running a full apply. Pass either:

- a resource type — `npm run push -- my-org assistants`, or
- a path — `npm run push -- my-org assistants/foo.yml` (short form)
  or `npm run push -- my-org resources/my-org/assistants/foo.yml` (long form).

---

## API Reference

- [Assistants API](https://docs.vapi.ai/api-reference/assistants/create)
- [Tools API](https://docs.vapi.ai/api-reference/tools/create)
- [Structured Outputs API](https://docs.vapi.ai/api-reference/structured-outputs/structured-output-controller-create)
- [Squads API](https://docs.vapi.ai/api-reference/squads/create)
- [Evals API](https://docs.vapi.ai/api-reference/evals)
