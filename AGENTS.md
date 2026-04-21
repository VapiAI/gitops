# Vapi GitOps — Agent Guide

This project manages **Vapi voice agent configurations** as code. All resources (assistants, tools, squads, etc.) are declarative files that sync to the Vapi platform via a gitops engine.

**You do NOT need to know how Vapi works internally.** This guide tells you everything you need to author and modify resources.

**Prompt quality:** Whenever you create a new assistant or change an existing assistant’s system prompt, read **`docs/Vapi Prompt Optimization Guide.md`** first. It goes deeper on structure, voice constraints, tool usage, and evaluation than the summary in this file.

**Org-scoped resources:** Resources live in `resources/<org>/` (e.g. `resources/my-org/`, `resources/my-org-prod/`). Each org directory is isolated — `npm run push -- my-org` only touches `resources/my-org/`. Run `npm run setup` to create a new org.

**Template-safe first run:** In a fresh clone, prefer `npm run pull -- <org> --bootstrap` to refresh `.vapi-state.<org>.json` and credential mappings without materializing the target org's resources into `resources/<org>/`. `npm run push -- <org>` will auto-run the same bootstrap sync when it detects empty or stale state for the resources being applied.

**Excluding resources from sync (`.vapi-ignore`):** To prevent specific resources from being pulled at all (e.g. assistants owned by another team or legacy resources you don't want to manage), create `resources/<env>/.vapi-ignore` with gitignore-style patterns. See `resources/<env>/.vapi-ignore.example` for syntax and examples. Ignored resources are silently skipped on every pull and never tracked in state — distinct from "locally deleted" which keeps an entry in state.

**Learnings & recipes:** Before configuring resources or debugging issues, read the relevant file in **`docs/learnings/`**. Load only what you need:

| Working on | Read |
|------------|------|
| Assistants (model, voice, transcriber, hooks) | `docs/learnings/assistants.md` |
| Tools (apiRequest, function, transferCall, handoff, code) | `docs/learnings/tools.md` |
| Squads / multi-agent handoffs | `docs/learnings/squads.md` |
| Transfers not working | `docs/learnings/transfers.md` |
| Structured outputs / post-call analysis | `docs/learnings/structured-outputs.md` |
| Simulations / test suites | `docs/learnings/simulations.md` |
| Webhooks / server config | `docs/learnings/webhooks.md` |
| Latency optimization | `docs/learnings/latency.md` |
| Fallback providers / error hooks | `docs/learnings/fallbacks.md` |
| Azure OpenAI BYOK with regional failover | `docs/learnings/azure-openai-fallback.md` |
| Multilingual agents (English/Spanish) | `docs/learnings/multilingual.md` |
| WebSocket audio streaming | `docs/learnings/websocket.md` |
| Building outbound calling agents | `docs/learnings/outbound-agents.md` |
| Voicemail detection / VM vs human classification | `docs/learnings/voicemail-detection.md` |
| Enforcing call time limits / graceful call ending | `docs/learnings/call-duration.md` |

---

## Quick Reference

| I want to...                        | What to do                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Edit an assistant's system prompt   | Edit the markdown body in `resources/<org>/assistants/<name>.md`                  |
| Change assistant settings           | Edit the YAML frontmatter in the same `.md` file                                  |
| Add a new tool                      | Create `resources/<org>/tools/<name>.yml`                                         |
| Add a new assistant                 | Create `resources/<org>/assistants/<name>.md`                                     |
| Create a multi-agent squad          | Create `resources/<org>/squads/<name>.yml`                                        |
| Add post-call analysis              | Create `resources/<org>/structuredOutputs/<name>.yml`                             |
| Write test simulations              | Create files under `resources/<org>/simulations/`                                 |
| Promote resources across orgs       | Copy files between `resources/<org-a>/` and `resources/<org-b>/`                  |
| Test webhook event delivery locally | Run `npm run mock:webhook` and tunnel with ngrok                                  |
| Push changes to Vapi                | `npm run push -- <org>`                                                           |
| Pull latest from Vapi               | `npm run pull -- <org>`, `--force`, or `--bootstrap`                              |
| Pull one known remote resource      | `npm run pull -- <org> --type assistants --id <uuid>`                             |
| Push only one file                  | `npm run push -- <org> resources/<org>/assistants/my-agent.md`                    |
| Test a call                         | `npm run call -- <org> -a <assistant-name>`                                       |

---

## Project Structure

```
docs/
├── Vapi Prompt Optimization Guide.md          # In-depth prompt authoring
├── changelog.md                               # Template for tracking per-customer config changes
└── learnings/                                 # Gotchas, recipes, and troubleshooting
    ├── README.md                              # Task-routed index — start here
    ├── tools.md                               # Tool configuration gotchas
    ├── assistants.md                          # Assistant configuration gotchas
    ├── squads.md                              # Squad and multi-agent gotchas
    ├── structured-outputs.md                  # Structured output gotchas + KPI patterns
    ├── simulations.md                         # Simulation and testing gotchas
    ├── webhooks.md                            # Server and webhook gotchas
    ├── transfers.md                           # Transfer troubleshooting runbook
    ├── latency.md                             # Latency optimization guide
    ├── fallbacks.md                           # Fallback and error handling recipes
    ├── azure-openai-fallback.md               # Azure OpenAI BYOK multi-region setup
    ├── multilingual.md                        # Multilingual agent architecture guide
    ├── websocket.md                           # WebSocket transport rules
    ├── outbound-agents.md                     # Outbound agent design & IVR navigation
    └── voicemail-detection.md                 # Voicemail vs human classification

resources/
├── <org>/                   # Org-scoped resources (npm run push -- <org> reads here)
│   ├── assistants/
│   ├── tools/
│   ├── squads/
│   ├── structuredOutputs/
│   ├── evals/
│   └── simulations/
└── <another-org>/           # Another org (each is isolated)
    └── (same structure)

scripts/
└── mock-vapi-webhook-server.ts        # Local webhook receiver for server message testing
```

---

## Resource Formats

### Assistants (`.md`) — The Most Important Resource

Assistants are voice agents that handle phone calls. They are defined as **Markdown files with YAML frontmatter**.

**File:** `resources/<org>/assistants/<name>.md`

```markdown
---
name: My Assistant
firstMessage: Hi, thanks for calling! How can I help you today?
voice:
  provider: 11labs
  voiceId: your-voice-id-here
  model: eleven_turbo_v2
  stability: 0.7
  similarityBoost: 0.75
  speed: 1.1
  enableSsmlParsing: true
model:
  provider: openai
  model: gpt-4.1
  temperature: 0
  toolIds:
    - end-call-tool
    - transfer-call
transcriber:
  provider: deepgram
  model: nova-3
  language: en
  numerals: true
  confidenceThreshold: 0.5
endCallFunctionEnabled: true
endCallMessage: Thank you for calling. Have a great day!
silenceTimeoutSeconds: 30
maxDurationSeconds: 600
backgroundDenoisingEnabled: true
backgroundSound: off
---

# Identity & Purpose

You are a virtual assistant for the business you represent...

# Workflow

## STEP 1: Greeting

...
```

**How it works:**

- Everything between `---` markers = **YAML configuration** (voice, model, tools, etc.)
- Everything below the second `---` = **system prompt** (markdown, sent as the LLM system message)
- The system prompt IS the core behavior definition — write it like detailed instructions for an AI

#### Key Assistant Settings

| Setting                      | Purpose                                            | Common Values                                                                                                                     |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`                       | Display name in Vapi dashboard                     | Any string                                                                                                                        |
| `firstMessage`               | What the assistant says first when a call connects | Greeting text (supports SSML like `<break time='0.3s'/>`)                                                                         |
| `firstMessageMode`           | How the first message is generated                 | `assistant-speaks-first` (default, uses `firstMessage`), `assistant-speaks-first-with-model-generated-message` (LLM generates it) |
| `voice`                      | Text-to-speech configuration                       | See Voice section below                                                                                                           |
| `model`                      | LLM configuration                                  | See Model section below                                                                                                           |
| `transcriber`                | Speech-to-text configuration                       | See Transcriber section below                                                                                                     |
| `endCallFunctionEnabled`     | Allow the assistant to hang up                     | `true` / `false`                                                                                                                  |
| `endCallMessage`             | What to say when ending the call                   | Text string                                                                                                                       |
| `silenceTimeoutSeconds`      | Hang up after N seconds of silence                 | `30` typical                                                                                                                      |
| `maxDurationSeconds`         | Maximum call duration                              | `600` (10 min) typical                                                                                                            |
| `backgroundDenoisingEnabled` | Reduce background noise                            | `true` / `false`                                                                                                                  |
| `backgroundSound`            | Ambient sound during pauses                        | `off`, `office`                                                                                                                   |
| `voicemailMessage`           | Message to leave if voicemail detected             | Text string                                                                                                                       |
| `hooks`                      | Event-driven actions (see Hooks section)           | Array of hook objects                                                                                                             |
| `messagePlan`                | Idle message behavior                              | See below                                                                                                                         |
| `startSpeakingPlan`          | Endpointing configuration                          | See below                                                                                                                         |
| `stopSpeakingPlan`           | Interruption sensitivity                           | See below                                                                                                                         |
| `server`                     | Webhook server for tool calls                      | `{ url, timeoutSeconds, credentialId }`                                                                                           |
| `serverMessages`             | Which events to send to webhook                    | `["end-of-call-report", "status-update"]`                                                                                         |
| `analysisPlan`               | Post-call analysis configuration                   | See below                                                                                                                         |
| `artifactPlan`               | What to save after calls                           | See below                                                                                                                         |
| `observabilityPlan`          | Logging/monitoring                                 | `{ provider: "langfuse", tags: [...] }`                                                                                           |
| `compliancePlan`             | HIPAA/PCI compliance                               | `{ hipaaEnabled: false, pciEnabled: false }`                                                                                      |

#### Voice Configuration

```yaml
voice:
  provider: 11labs # 11labs, playht, cartesia, azure, deepgram, openai, rime, lmnt
  voiceId: your-voice-id-here # Provider-specific voice ID
  model: eleven_turbo_v2 # Provider-specific model
  stability: 0.7 # 0.0-1.0, higher = more consistent
  similarityBoost: 0.75 # 0.0-1.0, higher = closer to original voice
  speed: 1.1 # Speech rate multiplier
  enableSsmlParsing: true # Allow SSML tags in responses
  inputPunctuationBoundaries: # When to start TTS (chunk boundaries)
    - "."
    - "!"
    - "?"
    - ";"
    - ","
```

#### Model (LLM) Configuration

```yaml
model:
  provider: openai # openai, anthropic, google, azure-openai, groq, cerebras
  model: gpt-4.1 # Provider-specific model name
  temperature: 0 # 0.0-2.0, lower = more deterministic
  toolIds: # Tools this assistant can use (reference by filename)
    - my-tool-name
    - another-tool
```

#### Transcriber (STT) Configuration

```yaml
transcriber:
  provider: deepgram # deepgram, assemblyai, azure, google, openai, gladia
  model: nova-3 # Provider-specific model
  language: en # Language code
  numerals: true # Convert spoken numbers to digits
  confidenceThreshold: 0.5 # Minimum confidence to accept transcription
```

#### Hooks (Event-Driven Actions)

Hooks trigger actions based on call events:

```yaml
hooks:
  # Say something when transcription confidence is low
  - on: assistant.transcriber.endpointedSpeechLowConfidence
    options:
      confidenceMin: 0.2
      confidenceMax: 0.49
    do:
      - type: say
        exact: "I'm sorry, I didn't quite catch that. Could you please repeat?"

  # End call on long customer silence
  - on: customer.speech.timeout
    options:
      timeoutSeconds: 90
    do:
      - type: say
        exact: "I'll be ending the call now. Please feel free to call back anytime."
      - type: tool
        tool:
          type: endCall
```

#### Message Plan (Idle Behavior)

```yaml
messagePlan:
  idleTimeoutSeconds: 15 # Seconds before idle message
  idleMessages: # Messages to say when idle
    - "I'm still here if you need assistance."
    - "Are you still there?"
  idleMessageMaxSpokenCount: 3 # Max idle messages before giving up
  idleMessageResetCountOnUserSpeechEnabled: true # Reset counter when user speaks
```

#### Start Speaking Plan (Endpointing)

Controls when the assistant starts responding after the user stops speaking:

```yaml
startSpeakingPlan:
  smartEndpointingPlan:
    provider: livekit
    waitFunction: "20 + 500 * sqrt(x) + 2500 * x^3" # Custom wait curve
```

#### Stop Speaking Plan (Interruption)

```yaml
stopSpeakingPlan:
  numWords: 1 # How many user words before assistant stops speaking (lower = more interruptible)
```

#### Analysis Plan (Post-Call Summaries)

```yaml
analysisPlan:
  summaryPlan:
    enabled: true
    messages:
      - role: system
        content: "Summarize this call concisely. Include: ..."
      - role: user
        content: |
          Here is the transcript:
          {{transcript}}
          Here is the ended reason:
          {{endedReason}}
```

#### Artifact Plan (Post-Call Data)

```yaml
artifactPlan:
  fullMessageHistoryEnabled: true # Save full message history
  structuredOutputIds: # Run these structured outputs after call
    - customer-data
    - call-summary
```

---

### Tools (`.yml`)

Tools are functions the assistant can call during a conversation.

**File:** `resources/<org>/tools/<name>.yml`

#### Function Tool (calls a webhook)

```yaml
type: function
async: false
function:
  name: get_weather
  description: Get the current weather for a location
  strict: true
  parameters:
    type: object
    properties:
      location:
        type: string
        description: The city name
      unit:
        type: string
        enum: [celsius, fahrenheit]
        description: Temperature unit
    required:
      - location
messages:
  - type: request-start
    blocking: true
    content: "Let me check the weather for you."
  - type: request-response-delayed
    timingMilliseconds: 5000
    content: "Still looking that up."
server:
  url: https://my-api.com/weather
  timeoutSeconds: 20
  credentialId: optional-credential-uuid # Optional: server auth credential
  headers: # Optional: custom request headers
    Content-Type: application/json
```

#### Transfer Call Tool

```yaml
type: transferCall
async: false
function:
  name: transfer_call
  description: Transfer the caller to a human agent
destinations:
  - type: number
    number: "+15551234567"
    numberE164CheckEnabled: true
    message: "Please hold while I transfer you."
    transferPlan:
      mode: blind-transfer
      sipVerb: refer
messages:
  - type: request-start
    blocking: false
```

#### End Call Tool

```yaml
type: endCall
async: false
function:
  name: end_call
  description: Allows the agent to terminate the call
  parameters:
    type: object
    properties: {}
    required: []
messages:
  - type: request-start
    blocking: false
```

#### Handoff Tool (minimal — usually defined inline in squads)

```yaml
type: handoff
function:
  name: handoff_tool
```

#### Tool Message Types

| Type                       | Purpose                     | Key Properties                                          |
| -------------------------- | --------------------------- | ------------------------------------------------------- |
| `request-start`            | Said when tool is called    | `content`, `blocking` (pause speech until tool returns) |
| `request-response-delayed` | Said if tool takes too long | `content`, `timingMilliseconds`                         |
| `request-complete`         | Said when tool returns      | `content`                                               |
| `request-failed`           | Said when tool errors       | `content`                                               |

---

### Structured Outputs (`.yml`)

Structured outputs extract data from call transcripts after the call ends. They run LLM analysis on the conversation.

**File:** `resources/<org>/structuredOutputs/<name>.yml`

#### Boolean Output (yes/no evaluation)

```yaml
name: success_evaluation
type: ai
target: messages
description: "Determines if the call met its objectives"
assistant_ids:
  - a1b2c3d4-e5f6-7890-abcd-ef1234567890
model:
  provider: openai
  model: gpt-4.1-mini
  temperature: 0
schema:
  type: boolean
  description: "Return true if the call successfully met its objectives."
```

#### Object Output (structured data extraction)

```yaml
name: customer_data
type: ai
target: messages
description: "Extracts customer contact info and call details"
assistant_ids:
  - a1b2c3d4-e5f6-7890-abcd-ef1234567890
model:
  provider: openai
  model: gpt-4.1-mini
  temperature: 0
schema:
  type: object
  properties:
    customerName:
      type: string
      description: "The customer's full name"
    customerPhone:
      type: string
      description: "The customer's phone number"
    callReason:
      type: string
      description: "Why the customer called"
      enum: [new_inquiry, existing_project, complaint, spam]
    appointmentBooked:
      type: boolean
      description: "True if an appointment was booked"
```

#### String Output (free-text summary)

```yaml
name: call_summary
type: ai
target: messages
description: "Generates a concise summary of the conversation"
model:
  provider: openai
  model: gpt-4.1-mini
  temperature: 0
schema:
  type: string
  description: "Summarize the call in 2-3 sentences."
  minLength: 10
  maxLength: 500
```

**Notes:**

- `assistant_ids` uses **Vapi UUIDs** (not local filenames) — these are the IDs of assistants this output applies to
- `target: messages` means the LLM analyzes the full message history
- `type: ai` means an LLM generates the output (vs. `type: code` for programmatic)
- **`schema.type` must be a simple string** (e.g. `type: string`, `type: boolean`, `type: object`). Do NOT use a YAML array like `type: [string, "null"]` — the Vapi dashboard calls `.toLowerCase()` on this field and will crash with `TypeError: .toLowerCase is not a function` if it receives an array. For nullable values, express nullability in the `description` instead (e.g. "Return null if no follow-up is needed")

---

### Squads (`.yml`)

Squads define multi-agent systems where assistants can hand off to each other.

**File:** `resources/<org>/squads/<name>.yml`

```yaml
name: My Squad
members:
  - assistantId: intake-agent-a1b2c3d4 # References resources/<org>/assistants/<id>.md
    assistantOverrides: # Override assistant settings within this squad
      metadata:
        position: # Visual position in dashboard editor
          x: 250
          y: 100
      tools:append: # Add tools to this member (in addition to their own)
        - type: handoff
          async: false
          messages: []
          function:
            name: handoff_to_Booking_Agent
            description: "Hand off to booking agent when customer wants to schedule"
            parameters:
              type: object
              properties:
                reason:
                  type: string
                  description: "Why the handoff is happening"
              required:
                - reason
          destinations:
            - type: assistant
              assistantName: Booking Assistant # Must match the `name` field in target assistant
              description: "Handles appointment booking"

  - assistantId: booking-agent-e5f67890
    assistantOverrides:
      metadata:
        position:
          x: 650
          y: 100
      tools:append:
        - type: handoff
          async: false
          messages: []
          function:
            name: handoff_back_to_Intake
            description: "Hand back to intake agent for wrap-up"
          destinations:
            - type: assistant
              assistantName: Intake Assistant
              description: "Intake agent for call wrap-up"

membersOverrides: # Settings applied to ALL members
  transcriber:
    provider: deepgram
    model: nova-3
    language: en
  hooks:
    - on: customer.speech.timeout
      options:
        timeoutSeconds: 90
      do:
        - type: say
          exact: "Ending the call now. Feel free to call back."
        - type: tool
          tool:
            type: endCall
  observabilityPlan:
    provider: langfuse
    tags:
      - my-tag
```

**Key Concepts:**

- `assistantId` references an assistant file by filename (without extension)
- `tools:append` adds handoff tools without replacing the assistant's existing tools
- Handoff `destinations` link to other squad members by `assistantName` (the `name` field in their YAML frontmatter)
- `membersOverrides` applies settings to all members (useful for shared transcriber, hooks, etc.)
- Handoff functions can have parameters that pass context between agents

---

### Simulations (Test Infrastructure)

Simulations let you test assistants with automated "caller" personas.

#### Personalities (`simulations/personalities/<name>.yml`)

Define simulated caller behaviors:

```yaml
name: Skeptical Sam
assistant:
  model:
    provider: openai
    model: gpt-4.1
    messages:
      - role: system
        content: >
          You are skeptical and need convincing before trusting information.
          You question everything and ask for specifics.
    tools:
      - type: endCall
```

#### Scenarios (`simulations/scenarios/<name>.yml`)

Define test case scripts with evaluation criteria:

```yaml
name: "Happy Path: New customer books appointment"
instructions: >
  You are a new customer calling to schedule an appointment.
  Provide your name as "John Smith", phone as "206-555-1234".
  Be cooperative and confirm all information.
  End the call when the assistant confirms the booking.
evaluations:
  - structuredOutputId: a1b2c3d4-e5f6-7890-abcd-ef1234567890
    comparator: "="
    value: true
    required: true
```

#### Simulations / Tests (`simulations/tests/<name>.yml`)

Combine a personality with a scenario:

```yaml
name: Happy Path Test 1
personalityId: skeptical-sam-a0000001 # References personalities/<id>.yml
scenarioId: happy-path-booking-a0000002 # References scenarios/<id>.yml
```

#### Simulation Suites (`simulations/suites/<name>.yml`)

Group simulations into test batches:

```yaml
name: Booking Flow Tests
simulationIds:
  - booking-test-1-a0000001
  - booking-test-2-a0000002
  - booking-test-3-a0000003
```

---

## Cross-Resource References

Resources reference each other by **filename without extension**:

| From          | Field                                | References              | Example                                   |
| ------------- | ------------------------------------ | ----------------------- | ----------------------------------------- |
| Assistant     | `model.toolIds[]`                    | Tool files              | `- end-call-tool`                          |
| Assistant     | `artifactPlan.structuredOutputIds[]` | Structured Output files | `- customer-data`                          |
| Squad         | `members[].assistantId`              | Assistant files         | `assistantId: intake-agent-a1b2c3d4`       |
| Squad handoff | `destinations[].assistantName`       | Assistant `name` field  | `assistantName: Booking Assistant`         |
| Simulation    | `personalityId`                      | Personality files       | `personalityId: skeptical-sam-a0000001`   |
| Simulation    | `scenarioId`                         | Scenario files          | `scenarioId: happy-path-booking-a0000002` |
| Suite         | `simulationIds[]`                    | Simulation test files   | `- booking-test-1-a0000001`               |

The gitops engine resolves these local filenames to Vapi UUIDs automatically during push.

---

## Writing System Prompts (Best Practices)

The markdown body of an assistant `.md` file is the system prompt — the core instructions that define how the AI behaves on a call. This is the most important part to get right.

**Before drafting or changing prompts:** work through **`docs/Vapi Prompt Optimization Guide.md`** so structure, guardrails, and voice-specific habits stay consistent across agents.

### Recommended Structure

```markdown
# Identity & Purpose

Who the assistant is and what it does.

# Guardrails

Hard rules that override everything else:

- Scope limits (what topics to handle)
- Data protection (what NOT to collect)
- Abuse handling
- Off-topic deflection
- Fabrication prohibition

# Primary Objectives

Numbered list of what the assistant should accomplish.

# Personality

Tone, style, language constraints.

# Response Guidelines

How to speak, confirm information, format numbers/prices, etc.

# Context

## Business Knowledge Base

Static facts: hours, services, contact info, service areas.

## Customer Context

Dynamic variables: {{ customer.number }}, current date/time.

# Workflow

## STEP 1: ...

## STEP 2: ...

## STEP 3: ...

Detailed step-by-step conversation flow.

# Error Handling

What to do when things go wrong (tool failures, repeated misunderstandings, etc.).

# Example Flows

Concrete example conversations showing expected behavior.
```

### Tips

- **One question at a time** — Voice agents should never ask multiple questions
- **Confirm critical fields** — Always repeat back names, phone numbers, addresses
- **Use SSML** — `<break time='0.5s'/>`, `<flush/>`, `<spell>text</spell>` for voice control
- **E.164 phone format** — Always store as `+1XXXXXXXXXX`
- **Guard against jailbreaks** — Include identity lock and prompt protection sections
- **Template variables** — Use `{{ customer.number }}` for caller phone, `{{"now" | date: "%A, %B %d, %Y"}}` for date/time
- **Tool call announcements** — Tell the user before calling tools: "Let me check that for you"
- **Transfer pattern** — Always speak first, then call transfer tool (two-step: say message, then tool call)

---

## Available Commands

```bash
# Setup
npm run setup                                      # Interactive wizard: API key, org slug, resource selection

# Sync
npm run pull -- <org>                              # Pull from Vapi (preserve local changes)
npm run pull -- <org> --force                      # Pull from Vapi (overwrite everything)
npm run pull -- <org> --bootstrap                  # Refresh state without writing remote resources locally
npm run pull -- <org> --type squads --id <uuid>    # Pull one known remote resource by UUID
npm run push -- <org>                              # Push all local changes to Vapi
npm run push -- <org> assistants                   # Push only assistants
npm run push -- <org> resources/<org>/assistants/my-agent.md  # Push single file
npm run apply -- <org>                             # Pull then push (full sync)

# Testing
npm run call -- <org> -a <assistant-name>          # Call an assistant via WebSocket
npm run call -- <org> -s <squad-name>              # Call a squad via WebSocket
npm run eval -- <org> -s <squad-name>              # Run evals against a squad
npm run eval -- <org> -a <assistant-name>          # Run evals against an assistant
npm run mock:webhook                               # Run local webhook receiver for server message testing

# Maintenance
npm run cleanup -- <org>                           # Dry-run: show orphaned remote resources
npm run cleanup -- <org> --force                   # Delete orphaned remote resources

# Build
npm run build                                      # Type-check
```

All commands accept an org slug (e.g. `my-org`). Running without arguments launches interactive mode.

---

## Discovering Available Settings

For the **complete schema** of all available properties on each resource type, consult the Vapi API documentation:

| Resource           | API Docs                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Assistants         | https://docs.vapi.ai/api-reference/assistants/create                                      |
| Tools              | https://docs.vapi.ai/api-reference/tools/create                                           |
| Squads             | https://docs.vapi.ai/api-reference/squads/create                                          |
| Structured Outputs | https://docs.vapi.ai/api-reference/structured-outputs/structured-output-controller-create |
| Simulations        | https://docs.vapi.ai/api-reference/simulations                                            |

**For voice/model/transcriber provider options:**

- Voice providers: https://docs.vapi.ai/providers/voice
- Model providers: https://docs.vapi.ai/providers/model
- Transcriber providers: https://docs.vapi.ai/providers/transcriber

**For feature-specific documentation:**

- Hooks: https://docs.vapi.ai/assistants/hooks
- Tools: https://docs.vapi.ai/tools
- Squads: https://docs.vapi.ai/squads
- Workflows: https://docs.vapi.ai/workflows

> **Tip:** The Vapi MCP server and API reference pages provide full JSON schemas with all available fields, enums, and defaults. Use them to discover settings not covered in this guide.

---

## Naming Conventions

- **Filenames** include a UUID suffix for uniqueness: `my-agent-a1b2c3d4.md`
- The UUID suffix comes from the Vapi platform ID (first 8 chars of the UUID)
- New resources created locally don't need the UUID suffix — it gets added after first push
- **Tool function names** use `snake_case`: `book_appointment`, `check_availability`
- **Assistant names** use natural language: `Intake Assistant`, `Booking Assistant`
- **Structured output names** use `snake_case`: `customer_data`, `call_summary`

---

## Common Patterns

### Transfer to Human

Two-step pattern (speak first, then call tool):

In the system prompt:

```
When transferring to human:
1. First: Speak transfer message ending with <break time='0.5s'/><flush/>
2. Second: Call transfer_call with no spoken text
```

### Multi-Agent Handoff (Squad)

1. Create each agent as a separate assistant `.md` file
2. Create a squad `.yml` that lists them as members
3. Define handoff tools in `tools:append` on each member
4. Handoff functions can pass parameters (context) between agents

### Post-Call Data Extraction

1. Create structured outputs for the data you want
2. Reference them in the assistant's `artifactPlan.structuredOutputIds`
3. After each call, Vapi runs the LLM analysis and stores results

### Testing with Simulations

1. Create personalities (how the simulated caller behaves)
2. Create scenarios (what the simulated caller says + evaluation criteria)
3. Create simulations (pair personality + scenario)
4. Create suites (batch simulations together)
5. Run via Vapi dashboard or API

### Mock Server Testing (Webhook/Message Receipt)

If you need a local mock server to validate webhook payloads or message delivery behavior, you can add scripts under `/scripts` (for example: `scripts/mock-vapi-webhook-server.ts`) and run them locally during testing.

- Default expectation: no provider API key is needed for local receive-only mock testing.
- If a provider-specific key is required, refer to the Vapi monorepo secrets workflow and use `dotenvx` to decrypt the needed values.
- Assume decryption only works when the corresponding private keys are already available in your zsh environment.
- For local webhook validation, prioritize core `serverMessages` event types such as `speech-update`, `status-update`, and `end-of-call-report`.
- To test callbacks from Vapi into your local machine, expose the mock server with a tunnel like `ngrok` and use that public HTTPS URL in `assistant.server.url`.
