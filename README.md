# Vapi GitOps

Manage Vapi resources via Git using YAML/Markdown as the source-of-truth.

## Why GitOps?

| | Dashboard / Ad-hoc API | GitOps |
|---|---|---|
| **History** | Limited visibility of who changed what | Full git history with blame |
| **Review** | Changes go live immediately (can break things) | PR review before deploy |
| **Rollback** | Manual recreation | `git revert` + push |
| **Environments** | Tedious to copy-paste between envs | Same config, different state files |
| **Collaboration** | One person at a time. Need to duplicate assistants, tools, etc. | Team can collaborate and use git branching |
| **Reproducibility** | "It worked on my assistant!" | Declarative, version-controlled |
| **Disaster Recovery** | Hope you have backups | Re-apply from git |

### Key Benefits

- **Audit Trail** — Every change is a commit with author, timestamp, and reason
- **Code Review** — Catch misconfigurations before they hit production
- **Environment Parity** — Dev, staging, and prod stay in sync
- **No Drift** — Pull merges platform changes; push makes git the truth
- **Automation Ready** — Plug into CI/CD pipelines

### Supported Resources

| Resource | Status | Format |
|----------|--------|--------|
| **Assistants** | ✅ | `.md` (with system prompt) or `.yml` |
| **Tools** | ✅ | `.yml` |
| **Structured Outputs** | ✅ | `.yml` |
| **Squads** | ✅ | `.yml` |
| **Personalities** | ✅ | `.yml` |
| **Scenarios** | ✅ | `.yml` |
| **Simulations** | ✅ | `.yml` |
| **Simulation Suites** | ✅ | `.yml` |

---

## How to Use This Repo

1. **Sync from Vapi first** using `pull` so local files reflect platform state.
2. **Edit declarative resources** in `resources/<env>/` (`.md` assistants, `.yml` tools/squads/etc.).
3. **Push selectively while iterating** (resource type or file path), then run a full push before release.
4. **Promote by environment** (`dev` -> `stg` -> `prod`) by copying files between `resources/dev/`, `resources/stg/`, and `resources/prod/`.

Use:
- `pull` when Vapi might have changed
- `push` for explicit deploys
- `apply` (`pull -> merge -> push`) when you want one command for sync + deploy

---

## Quick Start

### Prerequisites

- Node.js installed
- Vapi API token

### Installation

```bash
npm install
```

### Setup Environment

```bash
# Copy example values, then set real keys
cp .env.example .env.dev
cp .env.example .env.stg
cp .env.example .env.prod

# Add the correct VAPI_TOKEN for each org/environment
# Note: this repo uses .env.stg (not .env.staging)
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Type-check the codebase |
| `npm run pull:dev` | Pull platform state, preserve local changes |
| `npm run pull:stg` | Pull staging state, preserve local changes |
| `npm run pull:dev:force` | Pull platform state, overwrite everything |
| `npm run pull:stg:force` | Pull staging state, overwrite everything |
| `npm run pull:prod` | Pull from prod, preserve local changes |
| `npm run pull:prod:force` | Pull from prod, overwrite everything |
| `npm run push:dev` | Push local files to Vapi (dev) |
| `npm run push:stg` | Push local files to Vapi (staging) |
| `npm run push:prod` | Push local files to Vapi (prod) |
| `npm run apply:dev` | Pull → Merge → Push in one shot (dev) |
| `npm run apply:stg` | Pull → Merge → Push in one shot (staging) |
| `npm run apply:prod` | Pull → Merge → Push in one shot (prod) |
| `npm run push:dev assistants` | Push only assistants (dev) |
| `npm run push:dev tools` | Push only tools (dev) |
| `npm run call:dev -- -a <name>` | Start a WebSocket call to an assistant (dev) |
| `npm run call:dev -- -s <name>` | Start a WebSocket call to a squad (dev) |
| `npm run mock:webhook` | Run local webhook receiver for Vapi server messages |

### Basic Workflow

```bash
# First time: pull all resources from Vapi for your target env
npm run pull:dev:force

# Commit the initial state
git add . && git commit -m "initial pull"

# Make changes to YAML/MD files under resources/

# Push your changes (full sync)
npm run push:dev
```

Promotion example:

```bash
# After validating in dev, copy to staging and push
cp resources/dev/squads/your-squad.yml resources/stg/squads/
npm run push:stg

# Promote to prod when ready
cp resources/stg/squads/your-squad.yml resources/prod/squads/
npm run push:prod
```

#### Pulling Without Losing Local Work

By default, `pull` preserves any files you've locally modified or deleted:

```bash
# Edit an assistant locally...

npm run pull:dev
# ⏭️  my-assistant (locally changed, skipping)
# ✨  new-tool -> resources/dev/tools/new-tool.yml
# Your edits are preserved, new platform resources are downloaded
```

#### Force Pull (Platform as Source of Truth)

When you want the platform version of everything, overwriting all local files:

```bash
npm run pull:dev:force
# ⚡ Force mode: overwriting all local files with platform state
```

#### Reviewing Platform Changes

```bash
# Pull platform state (your local changes are preserved)
npm run pull:dev

# See what changed on the platform vs your last commit
git diff

# Accept platform changes for a specific file
git checkout -- resources/dev/tools/some-tool.yml
```

### Selective Push (Partial Sync)

Push only specific resources instead of syncing everything:

#### By Resource Type

```bash
npm run push:dev assistants
npm run push:dev tools
npm run push:dev squads
npm run push:dev structuredOutputs
npm run push:dev personalities
npm run push:dev scenarios
npm run push:dev simulations
npm run push:dev simulationSuites
```

#### By Specific File(s)

```bash
# Push a single file
npm run push:dev resources/dev/assistants/my-assistant.md

# Push multiple files
npm run push:dev resources/dev/assistants/booking.md resources/dev/tools/my-tool.yml
```

#### Combined

```bash
# Push specific file within a type
npm run push:dev assistants resources/dev/assistants/booking.md
```

**Note:** Partial pushes skip deletion checks. Run full `npm run push:dev` to sync deletions.

#### Auto-Dependency Resolution

Partial push is ideal for promoting specific squads or assistants to staging/prod without pushing everything. The engine automatically detects and creates missing dependencies:

```bash
# Push a single squad to staging — tools, structured outputs, and
# assistants are created automatically if they don't exist yet
npm run push:stg resources/stg/squads/everblue-voice-squad-20374c37.yml

# Push assistants to prod — missing tools and structured outputs
# are auto-applied first so references resolve correctly
npm run push:prod assistants
```

The dependency chain resolves recursively:

```
Squad push
  └─ missing assistants? → auto-create them first
       └─ missing tools / structured outputs? → auto-create those first
            └─ then create the assistant
  └─ all references resolved → create the squad ✓

Assistant push
  └─ missing tools / structured outputs? → auto-create them first
  └─ all references resolved → create the assistant ✓
```

If a dependency already exists on the platform (UUID in the state file) but its nested dependencies don't, those are still auto-created and the parent resource is updated to reference them.

This means you can work on everything in dev, then selectively push a single squad or assistant to staging or prod — no need for a full `push` that touches every resource.

### Webhook Local Testing

Use the local mock receiver when validating Vapi `serverMessages` delivery.

```bash
# 1) Run local receiver
npm run mock:webhook

# 2) Expose localhost (example)
ngrok http 8787
```

Then set your assistant `server.url` to the ngrok HTTPS URL and include event types like:
- `speech-update`
- `status-update`
- `end-of-call-report`

The mock server exposes:
- `POST /webhook` (or `POST /`)
- `GET /health`
- `GET /events`

---

## Project Structure

```
vapi-gitops/
├── docs/
│   ├── Vapi Prompt Optimization Guide.md   # Prompt authoring reference
│   ├── environment-scoped-resources.md     # Env isolation & promotion workflow
│   └── changelog.md                        # Template for per-customer change tracking
├── src/
│   ├── pull.ts                 # Pull platform state (with git stash/pop merge)
│   ├── push.ts                 # Push local state to platform
│   ├── apply.ts                # Orchestrator: pull → merge → push
│   ├── call.ts                 # WebSocket call script
│   ├── types.ts                # TypeScript interfaces
│   ├── config.ts               # Environment & configuration
│   ├── api.ts                  # Vapi HTTP client
│   ├── state.ts                # State file management
│   ├── resources.ts            # Resource loading (YAML, MD, TS)
│   ├── resolver.ts             # Reference resolution
│   ├── credentials.ts          # Credential resolution (name ↔ UUID)
│   └── delete.ts               # Deletion & orphan checks
├── resources/
│   ├── dev/                    # Dev environment resources (push:dev reads here)
│   │   ├── assistants/
│   │   ├── tools/
│   │   ├── squads/
│   │   ├── structuredOutputs/
│   │   └── simulations/
│   ├── stg/                    # Staging resources (push:stg reads here)
│   │   └── (same structure)
│   └── prod/                   # Production resources (push:prod reads here)
│       └── (same structure)
├── scripts/
│   └── mock-vapi-webhook-server.ts # Local server message receiver
├── .env.example                # Example env var file
├── .env.dev                    # Dev environment secrets (gitignored)
├── .env.stg                    # Staging environment secrets (gitignored)
├── .env.prod                   # Prod environment secrets (gitignored)
├── .vapi-state.dev.json        # Dev state file
├── .vapi-state.stg.json        # Staging state file
└── .vapi-state.prod.json       # Prod state file
```

---

## File Formats

### Assistants with System Prompts (`.md`)

Assistants with system prompts use **Markdown with YAML frontmatter**. The system prompt is written as readable Markdown below the config:

```markdown
---
name: My Assistant
voice:
  provider: 11labs
  voiceId: abc123
model:
  model: gpt-4o
  provider: openai
  toolIds:
    - my-tool
firstMessage: Hello! How can I help you?
---

# Identity & Purpose
You are a helpful assistant for Acme Corp.

# Conversation Flow
1. Greet the user
2. Ask how you can help
3. Resolve their issue

# Rules
- Always be polite
- Never make up information
```

**Benefits:**
- System prompts are readable Markdown (not escaped YAML strings)
- Proper syntax highlighting in editors
- Easy to write headers, lists, tables
- Configuration stays cleanly separated at the top

### Assistants without System Prompts (`.yml`)

Simple assistants without custom system prompts use plain YAML:

```yaml
name: Simple Assistant
voice:
  provider: vapi
  voiceId: Elliot
model:
  model: gpt-4o-mini
  provider: openai
firstMessage: Hello!
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
  Be cooperative and provide all requested information.
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
  - booking-test-case-3
```

---

## How-To Guides

### How to Add a New Assistant

**Option 1: With System Prompt (recommended)**

Create `resources/dev/assistants/my-assistant.md`:

```markdown
---
name: My Assistant
voice:
  provider: 11labs
  voiceId: abc123
model:
  model: gpt-4o
  provider: openai
  toolIds:
    - my-tool
---

# Your System Prompt Here
Instructions for the assistant...
```

**Option 2: Without System Prompt**

Create `resources/dev/assistants/my-assistant.yml`:

```yaml
name: My Assistant
voice:
  provider: vapi
  voiceId: Elliot
model:
  model: gpt-4o-mini
  provider: openai
```

Then push:

```bash
npm run push:dev
```

### How to Add a Tool

Create `resources/dev/tools/my-tool.yml`:

```yaml
type: function
function:
  name: do_something
  description: Does something useful
  parameters:
    type: object
    properties:
      input:
        type: string
    required:
      - input
server:
  url: https://my-api.com/endpoint
```

### How to Reference Resources

Use the **filename without extension** as the resource ID:

```yaml
# In an assistant
model:
  toolIds:
    - my-tool              # → resources/<env>/tools/my-tool.yml
    - utils/helper-tool    # → resources/<env>/tools/utils/helper-tool.yml
artifactPlan:
  structuredOutputIds:
    - call-summary         # → resources/<env>/structuredOutputs/call-summary.yml
```

```yaml
# In a squad
members:
  - assistantId: intake-agent    # → resources/<env>/assistants/intake-agent.md
```

```yaml
# In a simulation
personalityId: skeptical-sam     # → resources/<env>/simulations/personalities/skeptical-sam.yml
scenarioId: happy-path           # → resources/<env>/simulations/scenarios/happy-path.yml
```

### How to Delete a Resource

1. **Remove references** to the resource from other files
2. **Delete the file**: `rm resources/dev/tools/my-tool.yml`
3. **Push**: `npm run push:dev`

The engine will:
- Detect the resource is in state but not in filesystem
- Check for orphan references (will error if still referenced)
- Delete from Vapi
- Remove from state file

### How to Organize Resources into Folders

Create subdirectories for multi-tenant or feature organization:

```
resources/<env>/
├── assistants/
│   ├── shared/
│   │   └── fallback.md
│   └── client-a/
│       └── support.md
├── tools/
│   ├── shared/
│   │   └── transfer-call.yml
│   └── client-a/
│       └── custom-api.yml
```

Reference using full paths:

```yaml
model:
  toolIds:
    - shared/transfer-call
    - client-a/custom-api
```

---

## How the Engine Works

### Sync Workflow

Your local files are the source of truth. The engine respects that:

```
pull (default)     pull --force        push
─────────────      ─────────────       ─────────────
Download from      Download from       Upload local
platform, skip     platform, overwrite files to
locally changed    everything          platform
files
```

**`pull`** downloads platform state. In default mode (git repo required), it detects locally modified or deleted files and skips them — your local work is preserved. New platform resources are still downloaded. Use `--force` to overwrite everything.

**`push`** is the engine — reads local files and syncs them to the platform. Deleted files are removed from the platform.

**`apply`** is the convenience wrapper — runs `pull` then `push` in sequence.

> **Note:** The "skip locally changed files" feature requires a git repo with at least one commit. Without git, pull always overwrites (same as `--force`).

### Processing Order

**Pull** (dependency order):
1. Tools
2. Structured Outputs
3. Assistants
4. Squads
5. Personalities
6. Scenarios
7. Simulations
8. Simulation Suites

**Push** (dependency order):
1. Tools → 2. Structured Outputs → 3. Assistants → 4. Squads
5. Personalities → 6. Scenarios → 7. Simulations → 8. Simulation Suites

**Delete** (reverse dependency order):
1. Simulation Suites → 2. Simulations → 3. Scenarios → 4. Personalities
5. Squads → 6. Assistants → 7. Structured Outputs → 8. Tools

### Reference Resolution

The engine automatically resolves resource IDs to Vapi UUIDs:

```yaml
# You write:
toolIds:
  - my-tool

# Engine sends to API:
toolIds:
  - "uuid-1234-5678-abcd"
```

### Credential Management

Credentials (API keys, JWT secrets, etc.) are environment-specific and managed automatically through the state file. No secrets are stored in resource files or git.

**How it works:**

1. **Pull** fetches all credentials from `GET /credential` and stores `name-slug → UUID` in the state file
2. **Pull** replaces credential UUIDs with human-readable names in resource files
3. **Push** reverses the mapping — resolves credential names back to UUIDs before sending to the API

```yaml
# Resource file stores credential NAME (environment-agnostic)
server:
  url: https://my-api.com/endpoint
  credentialId: my-server-credential    # ← human-readable name
```

```json
// State file stores credential UUID (environment-specific)
{
  "credentials": {
    "my-server-credential": "2f6db611-ad08-4099-8bd8-74db37b0a07e"
  }
}
```

**Cross-environment workflow:**

Each environment has its own state file with its own credential UUIDs. The same resource file works across all environments — only the state file differs:

```
.vapi-state.dev.json  → "my-cred": "uuid-for-dev"
.vapi-state.stg.json  → "my-cred": "uuid-for-stg"
.vapi-state.prod.json → "my-cred": "uuid-for-prod"
```

> **Note:** Credentials are auto-discovered from the Vapi API by name. Create credentials with the same name in each environment's Vapi org, and pull will populate the mappings automatically.

### State File

Tracks mapping between resource IDs and Vapi UUIDs:

```json
{
  "credentials": {
    "my-server-credential": "uuid-0000"
  },
  "tools": {
    "my-tool": "uuid-1234"
  },
  "assistants": {
    "my-assistant": "uuid-5678"
  },
  "squads": {
    "my-squad": "uuid-abcd"
  },
  "personalities": {
    "skeptical-sam": "uuid-efgh"
  }
}
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VAPI_TOKEN` | ✅ | API authentication token |
| `VAPI_BASE_URL` | ❌ | API base URL (defaults to `https://api.vapi.ai`) |

### Excluded Fields

Some fields are excluded when writing to files (server-managed):

- `id`, `orgId`, `createdAt`, `updatedAt`
- `analyticsMetadata`, `isDeleted`
- `isServerUrlSecretSet`, `workflowIds`

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
1. Open `.vapi-state.{env}.json`
2. Find the resource entry
3. If incorrect, delete entry and re-run push

### "Credential with ID not found" errors

The credential UUID doesn't exist in the target environment. Fix:
1. Run `npm run pull:{env}` to fetch credentials into the state file
2. If the credential doesn't exist in the target org, create it in the Vapi dashboard with the same name
3. Pull again — the mapping will be auto-populated

### "Unresolved credential" warnings

A resource file has a `credentialId` that couldn't be resolved to a UUID. This means the credential name isn't in the state file. Run `pull` to populate credential mappings.

### "property X should not exist" API errors

Some properties can't be updated after creation. Add them to `UPDATE_EXCLUDED_KEYS` in `src/config.ts`.

---

## API Reference

- [Assistants API](https://docs.vapi.ai/api-reference/assistants/create)
- [Tools API](https://docs.vapi.ai/api-reference/tools/create)
- [Structured Outputs API](https://docs.vapi.ai/api-reference/structured-outputs/structured-output-controller-create)
- [Squads API](https://docs.vapi.ai/api-reference/squads/create)
