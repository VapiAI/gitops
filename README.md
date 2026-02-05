# Vapi GitOps

Manage Vapi resources via Git using YAML/Markdown as the source-of-truth.

## Why GitOps?

| | Dashboard / Ad-hoc API | GitOps |
|---|---|---|
| **History** | Limited visibility of who changed what | Full git history with blame |
| **Review** | Changes go live immediately (can break things) | PR review before deploy |
| **Rollback** | Manual recreation | `git revert` + apply |
| **Environments** | Tedious to copy-paste between envs | Same config, different state files |
| **Collaboration** | One person at a time. Need to duplicate assistants, tools, etc. | Team can collaborate and use git branching |
| **Reproducibility** | "It worked on my assistant!" | Declarative, version-controlled |
| **Disaster Recovery** | Hope you have backups | Re-apply from git |

### Key Benefits

- **Audit Trail** — Every change is a commit with author, timestamp, and reason
- **Code Review** — Catch misconfigurations before they hit production
- **Environment Parity** — Dev, staging, and prod stay in sync
- **No Drift** — Git is the truth; manual console changes get overwritten
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
# Create your .env file with your Vapi token
echo "VAPI_TOKEN=your-token-here" > .env.dev
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Type-check the codebase |
| `npm run pull:dev` | Pull resources from Vapi to local files |
| `npm run pull:prod` | Pull resources from prod |
| `npm run apply:dev` | Push all local files to Vapi (dev) |
| `npm run apply:prod` | Push all local files to Vapi (prod) |
| `npm run apply:dev assistants` | Push only assistants (dev) |
| `npm run apply:dev tools` | Push only tools (dev) |
| `npm run call:dev -- -a <name>` | Start a WebSocket call to an assistant (dev) |
| `npm run call:dev -- -s <name>` | Start a WebSocket call to a squad (dev) |

### Basic Workflow

```bash
# Pull existing resources from Vapi
npm run pull:dev

# Make changes to YAML/MD files...

# Push changes back to Vapi
npm run apply:dev
```

### Selective Apply (Partial Sync)

Push only specific resources instead of syncing everything:

#### By Resource Type

```bash
npm run apply:dev assistants
npm run apply:dev tools
npm run apply:dev squads
npm run apply:dev structuredOutputs
npm run apply:dev personalities
npm run apply:dev scenarios
npm run apply:dev simulations
npm run apply:dev simulationSuites
```

#### By Specific File(s)

```bash
# Push a single file
npm run apply:dev resources/assistants/my-assistant.md

# Push multiple files
npm run apply:dev resources/assistants/booking.md resources/tools/my-tool.yml
```

#### Combined

```bash
# Push specific file within a type
npm run apply:dev assistants resources/assistants/booking.md
```

**Note:** Partial applies skip deletion checks. Run full `npm run apply:dev` to sync deletions.

---

## Project Structure

```
vapi-gitops/
├── src/
│   ├── apply.ts                # Apply entry point & functions
│   ├── pull.ts                 # Pull entry point & functions
│   ├── call.ts                 # WebSocket call script
│   ├── types.ts                # TypeScript interfaces
│   ├── config.ts               # Environment & configuration
│   ├── api.ts                  # Vapi HTTP client
│   ├── state.ts                # State file management
│   ├── resources.ts            # Resource loading (YAML, MD, TS)
│   ├── resolver.ts             # Reference resolution
│   └── delete.ts               # Deletion & orphan checks
├── resources/
│   ├── assistants/             # Assistant files (.md or .yml)
│   ├── tools/                  # Tool YAML files
│   ├── structuredOutputs/      # Structured output YAML files
│   ├── squads/                 # Squad YAML files
│   └── simulations/            # Simulation resources
│       ├── personalities/      # Personality YAML files
│       ├── scenarios/          # Scenario YAML files
│       ├── tests/              # Simulation YAML files
│       └── suites/             # Simulation suite YAML files
├── .env.dev                    # Dev environment secrets (gitignored)
├── .env.prod                   # Prod environment secrets (gitignored)
├── .vapi-state.dev.json        # Dev state file
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

Create `resources/assistants/my-assistant.md`:

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

Create `resources/assistants/my-assistant.yml`:

```yaml
name: My Assistant
voice:
  provider: vapi
  voiceId: Elliot
model:
  model: gpt-4o-mini
  provider: openai
```

Then apply:

```bash
npm run apply:dev
```

### How to Add a Tool

Create `resources/tools/my-tool.yml`:

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
    - my-tool              # → resources/tools/my-tool.yml
    - utils/helper-tool    # → resources/tools/utils/helper-tool.yml
artifactPlan:
  structuredOutputIds:
    - call-summary         # → resources/structuredOutputs/call-summary.yml
```

```yaml
# In a squad
members:
  - assistantId: intake-agent    # → resources/assistants/intake-agent.md
```

```yaml
# In a simulation
personalityId: skeptical-sam     # → resources/simulations/personalities/skeptical-sam.yml
scenarioId: happy-path           # → resources/simulations/scenarios/happy-path.yml
```

### How to Delete a Resource

1. **Remove references** to the resource from other files
2. **Delete the file**: `rm resources/tools/my-tool.yml`
3. **Apply**: `npm run apply:dev`

The engine will:
- Detect the resource is in state but not in filesystem
- Check for orphan references (will error if still referenced)
- Delete from Vapi
- Remove from state file

### How to Organize Resources into Folders

Create subdirectories for multi-tenant or feature organization:

```
resources/
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

**Apply** (dependency order):
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

### State File

Tracks mapping between resource IDs and Vapi UUIDs:

```json
{
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
3. Apply again
4. Then delete the resource file

### Resource not updating

Check the state file has correct UUID:
1. Open `.vapi-state.{env}.json`
2. Find the resource entry
3. If incorrect, delete entry and re-run apply

### "property X should not exist" API errors

Some properties can't be updated after creation. Add them to `UPDATE_EXCLUDED_KEYS` in `src/config.ts`.

---

## API Reference

- [Assistants API](https://docs.vapi.ai/api-reference/assistants/create)
- [Tools API](https://docs.vapi.ai/api-reference/tools/create)
- [Structured Outputs API](https://docs.vapi.ai/api-reference/structured-outputs/structured-output-controller-create)
- [Squads API](https://docs.vapi.ai/api-reference/squads/create)
