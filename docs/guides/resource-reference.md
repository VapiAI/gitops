# Resource reference

Settings and examples for each resource type, with the gotchas that matter in
this repository. For complete schemas, see [Discovering available settings](#discovering-available-settings).
For a minimal, tested set of files to copy, see [File formats](file-formats.md).

## Assistants (`.md`)

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
- The system prompt IS the core behavior definition — write it like detailed instructions for an AI (see [Writing system prompts](writing-prompts.md))
- To let the assistant hang up, give it an `endCall` tool (the older `endCallFunctionEnabled` setting is deprecated)

### Key Assistant Settings

| Setting                      | Purpose                                            | Common Values                                                                                                                     |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`                       | Display name in Vapi dashboard                     | Any string                                                                                                                        |
| `firstMessage`               | What the assistant says first when a call connects | Greeting text (supports SSML like `<break time='0.3s'/>`)                                                                         |
| `firstMessageMode`           | How the first message is generated                 | `assistant-speaks-first` (default, uses `firstMessage`), `assistant-speaks-first-with-model-generated-message` (LLM generates it) |
| `voice`                      | Text-to-speech configuration                       | See Voice section below                                                                                                           |
| `model`                      | LLM configuration                                  | See Model section below                                                                                                           |
| `transcriber`                | Speech-to-text configuration                       | See Transcriber section below                                                                                                     |
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

### Voice Configuration

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

### Model (LLM) Configuration

```yaml
model:
  provider: openai # openai, anthropic, google, azure-openai, groq, cerebras
  model: gpt-4.1 # Provider-specific model name
  temperature: 0 # 0.0-2.0, lower = more deterministic
  toolIds: # Tools this assistant can use (reference by filename)
    - my-tool-name
    - another-tool
```

### Transcriber (STT) Configuration

```yaml
transcriber:
  provider: deepgram # deepgram, assemblyai, azure, google, openai, gladia
  model: nova-3 # Provider-specific model
  language: en # Language code
  numerals: true # Convert spoken numbers to digits
  confidenceThreshold: 0.5 # Minimum confidence to accept transcription
```

### Hooks (Event-Driven Actions)

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

### Message Plan (Idle Behavior)

```yaml
messagePlan:
  idleTimeoutSeconds: 15 # Seconds before idle message
  idleMessages: # Messages to say when idle
    - "I'm still here if you need assistance."
    - "Are you still there?"
  idleMessageMaxSpokenCount: 3 # Max idle messages before giving up
  idleMessageResetCountOnUserSpeechEnabled: true # Reset counter when user speaks
```

### Start Speaking Plan (Endpointing)

Controls when the assistant starts responding after the user stops speaking:

```yaml
startSpeakingPlan:
  smartEndpointingPlan:
    provider: livekit
    waitFunction: "20 + 500 * sqrt(x) + 2500 * x^3" # Custom wait curve
```

### Stop Speaking Plan (Interruption)

```yaml
stopSpeakingPlan:
  numWords: 1 # How many user words before assistant stops speaking (lower = more interruptible)
```

### Analysis Plan (Post-Call Summaries)

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

### Artifact Plan (Post-Call Data)

```yaml
artifactPlan:
  fullMessageHistoryEnabled: true # Save full message history
  structuredOutputIds: # Run these structured outputs after call
    - customer-data
    - call-summary
```

---

## Tools (`.yml`)

Tools are functions the assistant can call during a conversation.

**File:** `resources/<org>/tools/<name>.yml`

### Function Tool (calls a webhook)

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
  credentialId: my-api-credential # Optional: a credential NAME, bound to each org's own credential
  headers: # Optional: custom request headers
    Content-Type: application/json
```

### Transfer Call Tool

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

### End Call Tool

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

### Handoff Tool (minimal — usually defined inline in squads)

```yaml
type: handoff
function:
  name: handoff_tool
```

### Tool Message Types

| Type                       | Purpose                     | Key Properties                                          |
| -------------------------- | --------------------------- | ------------------------------------------------------- |
| `request-start`            | Said when tool is called    | `content`, `blocking` (pause speech until tool returns) |
| `request-response-delayed` | Said if tool takes too long | `content`, `timingMilliseconds`                         |
| `request-complete`         | Said when tool returns      | `content`                                               |
| `request-failed`           | Said when tool errors       | `content`                                               |

---

## Structured Outputs (`.yml`)

Structured outputs extract data from call transcripts after the call ends. They run LLM analysis on the conversation.

**File:** `resources/<org>/structuredOutputs/<name>.yml`

### Boolean Output (yes/no evaluation)

```yaml
name: success_evaluation
type: ai
target: messages
description: "Determines if the call met its objectives"
assistant_ids:
  - intake-assistant
model:
  provider: openai
  model: gpt-4.1-mini
  temperature: 0
schema:
  type: boolean
  description: "Return true if the call successfully met its objectives."
```

### Object Output (structured data extraction)

```yaml
name: customer_data
type: ai
target: messages
description: "Extracts customer contact info and call details"
assistant_ids:
  - intake-assistant
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

### String Output (free-text summary)

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

- `assistant_ids` lists the assistants this output applies to, by resource ID (file name without extension), like every other reference. The engine resolves them to each org's UUIDs; never paste UUIDs here
- `target: messages` means the LLM analyzes the full message history
- `type: ai` means an LLM generates the output (vs. `type: code` for programmatic)
- **`schema.type` must be a simple string** (e.g. `type: string`, `type: boolean`, `type: object`). Do NOT use a YAML array like `type: [string, "null"]` — the Vapi dashboard calls `.toLowerCase()` on this field and will crash with `TypeError: .toLowerCase is not a function` if it receives an array. For nullable values, express nullability in the `description` instead (e.g. "Return null if no follow-up is needed")

---

## Squads (`.yml`)

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

## Simulations (Test Infrastructure)

Simulations let you test assistants with automated "caller" personas.

### Personalities (`simulations/personalities/<name>.yml`)

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

### Scenarios (`simulations/scenarios/<name>.yml`)

Define test case scripts with evaluation criteria:

```yaml
name: "Happy Path: New customer books appointment"
instructions: >
  You are a new customer calling to schedule an appointment.
  Provide your name as "John Smith", phone as "206-555-1234".
  Be cooperative and confirm all information.
  End the call when the assistant confirms the booking.
evaluations:
  - structuredOutputId: booking-confirmed # a structuredOutputs/ file, by ID
    comparator: "="
    value: true
    required: true
```

### Simulations / Tests (`simulations/tests/<name>.yml`)

Combine a personality with a scenario:

```yaml
name: Happy Path Test 1
personalityId: skeptical-sam-a0000001 # References personalities/<id>.yml
scenarioId: happy-path-booking-a0000002 # References scenarios/<id>.yml
```

### Simulation Suites (`simulations/suites/<name>.yml`)

Group simulations into test batches:

```yaml
name: Booking Flow Tests
simulationIds:
  - booking-test-1-a0000001
  - booking-test-2-a0000002
  - booking-test-3-a0000003
```

## Common Patterns

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
5. Run them against deployed resources with `npm run sim`, or against your local files with `npm run check` (see [PR checks](pr-checks.md))

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
