# Vapi GitOps

Manage Vapi resources (Assistants, Structured Outputs, and Tools) via Git using YAML as the source-of-truth.

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

> ⚠️ **Note:** This project currently supports:
> - ✅ Assistants
> - ✅ Tools
> - ✅ Structured Outputs
>
> Want to manage other Vapi resources? The codebase is designed to be extensible.
> Add support for **Squads**, **Phone Numbers**, **Files**, **Knowledge Bases**, and more
> by following the patterns in `src/`.

## Quick Start

### Prerequisites

- Node.js installed
- Vapi API token

### Installation

```bash
cd vapi-gitops
npm install
```

This installs all dependencies including Bun locally (no global install needed).

### Setup Environment

```bash
# Create your .env file with your Vapi token
echo "VAPI_TOKEN=your-token-here" > .env.dev
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Type-check the codebase |
| `npm run pull:dev` | Pull resources from Vapi to local YAML files |
| `npm run pull:prod` | Pull resources from prod |
| `npm run apply:dev` | Push local YAML files to Vapi (dev) |
| `npm run apply:prod` | Push local YAML files to Vapi (prod) |
| `npm run call:dev -- -a <name>` | Start a WebSocket call to an assistant (dev) |
| `npm run call:dev -- -s <name>` | Start a WebSocket call to a squad (dev) |
| `npm run call:prod -- -a <name>` | Start a WebSocket call to an assistant (prod) |

### Basic Workflow

```bash
# Pull existing resources from Vapi
npm run pull:dev

# Make changes to YAML files...

# Push changes back to Vapi
npm run apply:dev
```

---

## How-To Guides

### How to Make a WebSocket Call to an Assistant or Squad

Test your assistants and squads directly from the terminal using real-time voice calls.

**Prerequisites (Optional but recommended for audio):**

```bash
# For microphone input and audio playback
npm install mic speaker

# macOS may require additional setup:
brew install sox
```

> **Note:** The call script works without these dependencies but will only show transcripts (no audio I/O).

**Step 1:** Ensure your assistant/squad is deployed

```bash
npm run apply:dev
```

**Step 2:** Start the call

```bash
# Call an assistant
bun run call:dev -a my-assistant

# Call a nested assistant (in subdirectory)
bun run call:dev -a company-1/inbound-support

# Call a squad
bun run call:dev -s my-squad

# Call in production
bun run call:prod -a my-assistant
```

**CLI Options:**

| Flag | Description |
|------|-------------|
| `-a <name>` | Call an assistant by name |
| `-s <name>` | Call a squad by name |

**Step 3:** Grant microphone permissions

On first run, the script will check for microphone permissions:
- **macOS**: You may see a system permission prompt. Grant access in System Preferences > Security & Privacy > Privacy > Microphone
- **Linux**: Ensure ALSA is configured and your user has access to audio devices
- **Windows**: You may be prompted to grant microphone access

**Step 4:** Speak into your microphone

The terminal will show:
- 🎤 Your speech transcripts
- 🤖 Assistant responses
- 📞 Call status updates

**Step 5:** End the call

Press `Ctrl+C` to gracefully end the call.

**Example output:**

```
🚀 Starting WebSocket call
   Environment: dev
   assistant: my-assistant

🎤 Checking microphone permissions...
✅ Microphone permission granted

   UUID: 88d807a0-854a-4a95-960f-6b69921ff877

📞 Creating call...
📞 Call ID: abc123-def456
🔌 Connecting to WebSocket...
✅ Connected!
🎤 Speak into your microphone...
   Press Ctrl+C to end the call

💬 Assistant started speaking...
🤖 Assistant: Hi there, this is Alex from TechSolutions customer support. How can I help you today?
🎤 You: I need help with my account
🤖 Assistant: I'd be happy to help you with your account. Could you tell me a bit more about what's happening?

^C
👋 Ending call...
📴 Call ended (code: 1000)
```

**Troubleshooting:**

| Issue | Solution |
|-------|----------|
| `Assistant not found` | Run `npm run apply:dev` first to deploy |
| `Squad not found` | Ensure squads are added to the state file |
| `mic module not installed` | Run `npm install mic` |
| `speaker module not installed` | Run `npm install speaker` |
| No audio on macOS | Install sox: `brew install sox` |
| Microphone permission denied | Check system privacy settings |

---

### How to Add a New Tool

**Step 1:** Create a new YAML file in `resources/tools/`

```bash
touch resources/tools/my-new-tool.yml
```

**Step 2:** Define the tool configuration

```yaml
# resources/tools/my-new-tool.yml
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

**Step 3:** Apply the changes

```bash
npm run apply:dev
```

The tool will be created and its UUID saved to `.vapi-state.dev.json`.

---

### How to Attach a Tool to an Assistant

**Step 1:** Note the tool's filename (without extension) - this is its resource ID

```
resources/tools/my-new-tool.yml  →  resource ID: "my-new-tool"
```

**Step 2:** Edit your assistant YAML and add the tool reference

```yaml
# resources/assistants/my-assistant.yml
name: My Assistant
model:
  provider: openai
  model: gpt-4o
  messages:
    - role: system
      content: You are a helpful assistant.
  toolIds:
    - my-new-tool    # ← Reference by filename (without .yml)
    - transfer-call  # ← You can add multiple tools
firstMessage: Hello! How can I help you?
```

**Step 3:** Apply the changes

```bash
npm run apply:dev
```

The apply engine will:
1. Create/update the tool first
2. Resolve `my-new-tool` → actual Vapi UUID
3. Create/update the assistant with the resolved UUID

---

### How to Add a Structured Output to an Assistant

**Step 1:** Create a structured output in `resources/structuredOutputs/`

```yaml
# resources/structuredOutputs/call-summary.yml
name: Call Summary
type: ai
description: Summarizes the key points of a call
schema:
  type: object
  properties:
    summary:
      type: string
      description: Brief summary of the call
    sentiment:
      type: string
      enum: [positive, neutral, negative]
    actionItems:
      type: array
      items:
        type: string
model:
  provider: openai
  model: gpt-4o
assistant_ids:
  - my-assistant  # ← Links to the assistant
workflow_ids: []
```

**Step 2:** Reference it in your assistant's artifact plan

```yaml
# resources/assistants/my-assistant.yml
name: My Assistant
model:
  provider: openai
  model: gpt-4o
  # ... other config
artifactPlan:
  structuredOutputIds:
    - call-summary  # ← Reference by filename
```

**Step 3:** Apply

```bash
npm run apply:dev
```

---

### How to Delete a Resource

**Step 1:** Remove any references to the resource first

If deleting a tool, remove it from all assistants' `toolIds`:

```yaml
# Before - resources/assistants/my-assistant.yml
model:
  toolIds:
    - transfer-call
    - my-tool-to-delete  # ← Remove this line

# After
model:
  toolIds:
    - transfer-call
```

**Step 2:** Delete the resource file

```bash
rm resources/tools/my-tool-to-delete.yml
```

**Step 3:** Apply

```bash
npm run apply:dev
```

The apply engine will:
1. Detect the resource is in state but not in filesystem
2. Check for orphan references (will error if still referenced)
3. Delete the resource from Vapi
4. Remove it from the state file

> ⚠️ **Important**: If you try to delete a resource that's still referenced, you'll get an error like:
> ```
> Cannot delete tool "my-tool" - still referenced by: assistants/my-assistant
> ```

---

### How to Rename a Resource

Renaming requires deleting the old and creating a new resource.

**Step 1:** Update all references to use the new name

```yaml
# resources/assistants/my-assistant.yml
model:
  toolIds:
    - new-tool-name  # ← Update to new name
```

**Step 2:** Rename the file

```bash
mv resources/tools/old-tool-name.yml resources/tools/new-tool-name.yml
```

**Step 3:** Apply

```bash
npm run apply:dev
```

This will:
1. Delete the old resource (old-tool-name)
2. Create the new resource (new-tool-name)
3. Update state file with new mapping

---

### How to Promote Changes Between Environments

**Step 1:** Test in dev first

```bash
npm run apply:dev
```

**Step 2:** Verify everything works, then apply to prod

```bash
npm run apply:prod
```

Each environment has its own:
- `.env.{env}` - API token
- `.vapi-state.{env}.json` - Resource UUID mappings

---

### How to Add a New Environment

Example: Adding a `staging` environment.

**Step 1:** Add the environment to the valid environments list

Edit `src/types.ts`:

```typescript
export type Environment = "dev" | "staging" | "prod";

export const VALID_ENVIRONMENTS: readonly Environment[] = ["dev", "staging", "prod"];
```

**Step 2:** Add a new npm script

Edit `package.json`:

```json
{
  "scripts": {
    "apply:dev": "tsx src/apply.ts dev",
    "apply:staging": "tsx src/apply.ts staging",
    "apply:prod": "tsx src/apply.ts prod"
  }
}
```

**Step 3:** Create the environment secrets file

```bash
echo "VAPI_TOKEN=your-staging-token" > .env.staging
```

**Step 4:** Initialize the state file (optional - created automatically on first run)

```bash
echo '{"assistants":{},"structuredOutputs":{},"tools":{}}' > .vapi-state.staging.json
```

**Step 5:** Apply to the new environment

```bash
npm run apply:staging
```

This creates all resources in the staging Vapi account and populates `.vapi-state.staging.json` with the new UUIDs.

---

### How to Organize Resources into Folders

You can create subdirectories to organize resources by tenant, team, or feature. The folder path becomes part of the resource ID.

**Example:** Multi-tenant setup with company-specific assistants and tools.

**Step 1:** Create folder structure

```
resources/
├── assistants/
│   ├── inbound-support.yml              # Shared/base assistant
│   └── company-1/
│       └── inbound-support.yml          # Company-specific assistant
├── tools/
│   ├── transfer-call.yml                # Shared tool
│   └── company-1/
│       └── transfer-call.yml            # Company-specific tool
└── structuredOutputs/
    └── customer-sentiment.yml           # Shared structured output
```

**Step 2:** Reference nested resources using their full path

In a nested assistant (`resources/assistants/company-1/inbound-support.yml`):

```yaml
name: Company 1 Support
model:
  provider: openai
  model: gpt-4o
  toolIds:
    - company-1/transfer-call  # ← Full path for nested tool
    - get-user                 # ← Root-level tool (no path)
artifactPlan:
  structuredOutputIds:
    - customer-sentiment       # ← Root-level structured output
```

**Step 3:** Link structured outputs to nested assistants

In `resources/structuredOutputs/customer-sentiment.yml`:

```yaml
name: Customer Sentiment
type: ai
schema:
  type: string
  enum: [positive, neutral, negative]
assistant_ids:
  - inbound-support              # ← Root-level assistant
  - company-1/inbound-support    # ← Nested assistant (full path!)
```

**Step 4:** Apply

```bash
npm run apply:dev
```

The state file will track both:

```json
{
  "assistants": {
    "inbound-support": "uuid-1111",
    "company-1/inbound-support": "uuid-2222"
  },
  "tools": {
    "transfer-call": "uuid-3333",
    "company-1/transfer-call": "uuid-4444"
  }
}
```

> ⚠️ **Important:** When referencing nested resources from any YAML file, always use the **full path** (e.g., `company-1/transfer-call`), not just the filename.

---

### How to Add Comments to YAML References

You can add inline comments to document references:

```yaml
model:
  toolIds:
    - transfer-call ## Transfers to human support
    - get-weather   ## Fetches weather data from API
artifactPlan:
  structuredOutputIds:
    - call-summary  ## Generated at end of each call
```

The apply engine strips everything after `##` when resolving references.

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
│   ├── resources.ts            # Resource loading
│   ├── resolver.ts             # Reference resolution
│   └── delete.ts               # Deletion & orphan checks
├── resources/
│   ├── assistants/             # Assistant YAML files
│   │   └── {tenant}/           # Optional: nested folders for multi-tenant
│   ├── structuredOutputs/      # Structured output YAML files
│   └── tools/                  # Tool YAML files
│       └── {tenant}/           # Optional: nested folders for multi-tenant
├── .env.dev                    # Dev environment secrets (gitignored)
├── .env.prod                   # Prod environment secrets (gitignored)
├── .vapi-state.dev.json        # Dev state file
└── .vapi-state.prod.json       # Prod state file
```

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VAPI_TOKEN` | ✅ | API authentication token |
| `VAPI_BASE_URL` | ❌ | API base URL (defaults to `https://api.vapi.ai`) |

### Update Exclusions

Some properties can't be sent during updates. Configure in `src/config.ts`:

```typescript
export const UPDATE_EXCLUDED_KEYS: Record<ResourceType, string[]> = {
  tools: ["type"],           // 'type' can't be changed after creation
  assistants: [],
  structuredOutputs: ["type"],
};
```

---

## State Files

State files track the mapping between resource IDs and Vapi UUIDs:

```json
{
  "assistants": {
    "my-assistant": "uuid-1234-5678"
  },
  "structuredOutputs": {
    "call-summary": "uuid-abcd-efgh"
  },
  "tools": {
    "transfer-call": "uuid-wxyz-1234"
  }
}
```

---

## How the Apply Engine Works

1. Load resource files from `/resources`
2. Load environment-specific state file
3. **Delete** orphaned resources (in state but not in filesystem)
4. For each resource:
   - If resource ID exists in state → **UPDATE** using stored UUID
   - If not → **CREATE** new resource, save UUID to state
5. Resolve cross-references (tool IDs → UUIDs)
6. Save updated state file

### Processing Order

**Deletions** (reverse dependency order):
1. Assistants → 2. Structured Outputs → 3. Tools

**Creates/Updates** (dependency order):
1. Tools → 2. Structured Outputs → 3. Assistants → 4. Link outputs to assistants

---

## API Reference

### Assistants
See [Vapi Assistants API](https://docs.vapi.ai/api-reference/assistants/create) for all available properties.

### Structured Outputs
See [Vapi Structured Outputs API](https://docs.vapi.ai/api-reference/structured-outputs/structured-output-controller-create?error=true) for all available properties.

### Tools
See [Vapi Tools API](https://docs.vapi.ai/api-reference/tools/create) for all available properties.

---

## Troubleshooting

### "Reference not found" warnings

The resource you're referencing doesn't exist yet. Make sure:
1. The referenced file exists in the correct folder
2. The filename matches exactly (case-sensitive)
3. You're using the filename without the `.yml` extension
4. For nested resources, use the **full path** (e.g., `company-1/transfer-call` not just `transfer-call`)

### Structured output not linking to nested assistant

When using folders, structured outputs must reference assistants by their full path:

```yaml
# ❌ Wrong - won't find the nested assistant
assistant_ids:
  - inbound-support

# ✅ Correct - uses full path for nested assistant  
assistant_ids:
  - inbound-support              # Root-level
  - company-1/inbound-support    # Nested (full path)
```

### "Cannot delete resource - still referenced"

Remove the reference from other resources before deleting:
1. Find which resources reference it (shown in error message)
2. Edit those files to remove the reference
3. Apply again
4. Then delete the resource file

### "property X should not exist" API errors

Some properties can't be updated after creation. Add them to `UPDATE_EXCLUDED_KEYS` in `src/config.ts`.

### Resource not updating

Check the state file has the correct UUID:
1. Open `.vapi-state.{env}.json`
2. Find the resource entry
3. If incorrect, delete the entry and re-run apply
