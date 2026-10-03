# File Formats

Every snippet below is a file from [`examples/starter/`](../../examples/starter/), a
small dental-clinic front desk with two assistants, tools, a handoff and a
simulation suite. CI checks that each snippet matches its file and that the
example passes `validate`, so you can copy from here safely.

A resource's ID is its path under the type folder, without the extension
(`tools/lookup-patient.yml` is `lookup-patient`). Reference other resources
by that ID, never by UUID: the engine resolves IDs to UUIDs per org.

## Assistants (`.md` or `.yml`)

Markdown with YAML frontmatter: the frontmatter is the assistant config and the
body is its system prompt.

```markdown
<!-- examples/starter/resources/starter/assistants/receptionist.md -->
---
name: Receptionist
firstMessage: Thanks for calling Bright Smile Dental. How can I help?
model:
  provider: openai
  model: gpt-4.1
  temperature: 0.3
  toolIds:
    - lookup-patient
    - handoff-to-scheduler
  tools:
    - type: endCall
voice:
  provider: 11labs
  voiceId: sarah
artifactPlan:
  structuredOutputIds:
    - call-summary
---

# Identity

You are the receptionist for Bright Smile Dental, 123 Main St. The clinic is
open Monday to Friday, 8am to 5pm.

# Flow

1. Ask for the caller's phone number and call `lookup_patient` with it.
2. If they want to book, change or check an appointment, hand off to the
   Scheduler with `handoff_to_scheduler`. Don't book anything yourself.
3. Answer general questions (hours, address) briefly yourself.
```

## Tools (`.yml`)

```yaml
# examples/starter/resources/starter/tools/lookup-patient.yml
type: function
function:
  name: lookup_patient
  description: Look up the caller's patient record by phone number.
  parameters:
    type: object
    properties:
      phone:
        type: string
        description: The caller's phone number
    required:
      - phone
server:
  url: https://example.com/vapi/lookup-patient
```

Handoffs between assistants are tools too. Give each one an explicit
`function.name` if your prompts mention it by name:

```yaml
# examples/starter/resources/starter/tools/handoff-to-scheduler.yml
type: handoff
function:
  name: handoff_to_scheduler
destinations:
  - type: assistant
    assistantId: scheduler
    description: Books, changes and checks appointments.
```

## Structured Outputs (`.yml`)

```yaml
# examples/starter/resources/starter/structuredOutputs/call-summary.yml
name: call-summary
type: ai
description: Summarizes the call for the front-desk log.
schema:
  type: object
  properties:
    summary:
      type: string
    booked:
      type: boolean
```

## Squads (`.yml`)

```yaml
# examples/starter/resources/starter/squads/front-desk.yml
name: Front Desk
members:
  - assistantId: receptionist
  - assistantId: scheduler
```

Members hand off to each other through handoff tools on the assistants, as
above. Prefer them over the legacy `assistantDestinations` field.

## Evals (`.yml`)

An eval file is the body of the [Evals API](https://docs.vapi.ai/api-reference/evals)
create request, written as YAML.

## Simulations

**Personality** (`simulations/personalities/`): the simulated caller, as an
assistant config.

```yaml
# examples/starter/resources/starter/simulations/personalities/calm-caller.yml
name: Calm caller
assistant:
  model:
    provider: openai
    model: gpt-4.1-mini
    messages:
      - role: system
        content: >
          You are a patient calling a dental clinic. Follow your scenario,
          answer questions briefly, and don't invent details.
```

**Scenario** (`simulations/scenarios/`): what the caller does, how the call is
judged (at least one evaluation), and mock results for the tools it calls.

```yaml
# examples/starter/resources/starter/simulations/scenarios/books-cleaning.yml
name: Books a cleaning
instructions: >
  You are Jordan Lee, phone 206-555-0142, an existing patient. Book a teeth
  cleaning for next Tuesday morning and accept the first slot offered. Once
  the booking is confirmed, say thanks and goodbye.
evaluations:
  - structuredOutputId: booking-confirmed
    comparator: "="
    value: true
    required: true
toolMocks:
  - toolName: lookup_patient
    result: '{"found": true, "patientId": "P-1001"}'
  - toolName: book_appointment
    result: '{"success": true, "date": "next Tuesday", "time": "09:00"}'
```

**Simulation** (`simulations/tests/`): a personality paired with a scenario.

```yaml
# examples/starter/resources/starter/simulations/tests/books-cleaning-calm.yml
name: Books a cleaning (calm caller)
personalityId: calm-caller
scenarioId: books-cleaning
```

**Simulation Suite** (`simulations/suites/`):

```yaml
# examples/starter/resources/starter/simulations/suites/core.yml
name: Core
simulationIds:
  - books-cleaning-calm
```

## TypeScript resources (`.ts`)

Any resource can also be a `.ts` file whose default export is the resource
object, useful for generating config. It is executed when loaded, so treat
`.ts` resources like code in review.
