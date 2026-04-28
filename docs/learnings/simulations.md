# Simulation & Testing Gotchas

Non-obvious behaviors and silent defaults for Vapi simulations, test suites, and evaluations.

---

## How Personalities Work

The simulation tester assistant is built from:
1. **Voice, model, and transcriber** from `personality.assistant`
2. **Persona prompt** from `personality.assistant.model.messages[0].content` (only the first message)
3. **Task instructions** from `scenario.instructions`
4. An **endCall tool** is always appended if not already present

Extra system messages beyond `messages[0]` are **not** included in the tester's prompt. The personality is primarily defined by that first system message.

---

## Evaluation Comparators

Simulation evaluations support these comparators:

| Comparator | Supported types |
|------------|-----------------|
| `=` | string, number, boolean |
| `!=` | string, number, boolean |
| `>` | number only |
| `<` | number only |
| `>=` | number only |
| `<=` | number only |

**Critical:** Evaluation schemas must use **primitive types only** (`string`, `number`, `integer`, `boolean`). Objects and arrays are rejected at validation and fail at extraction time.

**Note:** Test suite scorers (live tests) use a different system — an LLM judge with rubric grading, not comparator-based matching.

---

## Chat-Mode Evaluation Gotcha

Evaluations that require audio (`target: messages-with-audio`) are **skipped** in chat-mode simulations with `passed: false` and `isSkipped: true`.

**Critical:** If **all** required evaluations are audio-dependent and the simulation runs in chat mode, they're all skipped — and the run is treated as **passed** (0 required results = pass). This means your test suite can silently pass with no actual evaluation.

**Recommendation:** Include at least one text-based (`target: messages`) evaluation in every simulation that runs in chat mode.

---

## Missing References

- **At run creation (API):** Missing scenario or personality IDs fail the API request immediately with a validation error.
- **At execution:** Missing references fail the run. Retries depend on platform configuration.
- **Inline runs:** Require snapshots in metadata or fail with a "no inline config" error.

---

## Running Simulations Against Squads

Simulations can target squads directly using `target.type: "squad"` with the squad ID. Use the unified `POST /eval/simulation/run` endpoint and pass the suite via `simulations[]`:

```bash
curl -X POST "https://api.vapi.ai/eval/simulation/run" \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "simulations": [{"type": "simulationSuite", "simulationSuiteId": "your-suite-id"}],
        "target": {"type": "squad", "squadId": "your-squad-id"},
        "transport": {"provider": "vapi.websocket"},
        "iterations": 3
      }'
```

> The legacy `POST /eval/simulation/suite/{suiteId}/run` route was replaced by this unified runner — see the API reference at the bottom of this doc for the full payload shape.

**Voice mode (`vapi.websocket`)** exercises the full STT/TTS pipeline — use for latency testing and realistic end-to-end validation. **Chat mode (`vapi.webchat`)** is faster and cheaper — use for rapid iteration on outcome evaluations.

**Squad simulations test the full stack**: all tools attached to squad members (KB lookups, logging, email tools) actually fire during the simulation. If a tool endpoint is down, the simulation produces different results. Factor this into test design.

---

## A/B Testing Squads with Simulations

Run the same simulation suite against two squad variants and compare results:

1. Create both squad variants as separate resources (e.g., Squad A vs Squad B)
2. Run the same suite against each with identical iterations
3. Compare pass/fail rates on structured output evaluations
4. For latency comparison, use voice mode and analyze `end-of-call-report` webhook data from each run

**Limitation:** Simulations evaluate outcomes via structured output comparators, not platform-level metrics. There is no built-in p95 latency or dead-air measurement. For quantitative latency data, pipe `end-of-call-report` webhooks to your own analytics and compute metrics from `artifact.performanceMetrics`.

---

## Structured Outputs in Simulation Evaluations

Scenario evaluations reference structured outputs either by `structuredOutputId` (existing resource) or inline via `structuredOutput`. The key constraint: **evaluation schemas must use primitive types** (`string`, `number`, `integer`, `boolean`).

If your post-call analytics structured output uses `type: object` with nested schemas, you **cannot** use it directly as a scenario evaluation. Instead, create separate primitive-typed structured outputs for each evaluation criterion (e.g., `eval-call-outcome` as `type: string`, `eval-goal-achieved` as `type: boolean`). The full analytics output can still run via the squad's `artifactPlan.structuredOutputIds` — it just can't be used with comparators.

---

## Simulation File Names After Push

Simulation resource files use placeholder UUIDs (`a0000000`) locally. After the first push, the gitops engine creates platform resources and maps local filenames to platform UUIDs in `.vapi-state.<env>.json`. On subsequent state syncs (bootstrap), filenames may be updated to include the platform name — this triggers `name_mismatch` warnings that are resolved automatically by re-running bootstrap.

---

# API Endpoint Reference

All simulation endpoints are **alpha-tier** (mounted at `/api-alpha` in Swagger, `ApiTags(..., AlphaTag)`), require Bearer auth (private API key OR org JWT), and are scoped to the caller's organization.

Base URL: `https://api.vapi.ai`

| Resource | Base path | Purpose |
|----------|-----------|---------|
| Simulation | `/eval/simulation` | Pairs a `scenario` + `personality` for reuse |
| Scenario | `/eval/simulation/scenario` | What the tester does + how it's evaluated |
| Personality | `/eval/simulation/personality` | The tester assistant config (voice, model, persona) |
| Suite | `/eval/simulation/suite` | A named bundle of simulations |
| Run | `/eval/simulation/run` | Execute simulations/suites (batch); also exposes run items |
| Scenario Generator | `/eval/simulation/scenario/generate` | AI-generated scenarios from an assistant/squad |

> **Folder paths**: every resource type accepts an optional `path` (max 255 chars, 1–3 lowercase segments separated by `/`, e.g. `clients/acme`). Maps to the GitOps folder layout. Set to `null` on update to remove.

---

## Simulations (`/eval/simulation`)

### Create simulation — `POST /eval/simulation`

```jsonc
{
  "name": "Eligible Path with Confused User",   // optional, max 80
  "scenarioId": "uuid",                          // required
  "personalityId": "uuid",                       // required
  "path": "clients/acme"                         // optional
}
```

**Response 201** — full `Simulation` (id, orgId, scenarioId, personalityId, name, path, createdAt, updatedAt).

### List simulations — `GET /eval/simulation`

Query params:

| Param | Type | Notes |
|-------|------|-------|
| `limit` / `page` | int | Triggers paginated response when present |
| `idAny` | csv of uuids | Filter to specific simulation IDs |
| `standaloneOnly` | bool | Only simulations not in a suite |

Returns `Simulation[]` (or `{ data, total, limit, page }` paginated shape if pagination params are passed).

### Get / Update / Delete

- `GET /eval/simulation/:id` → `Simulation`
- `PATCH /eval/simulation/:id` → `Simulation` (body: any of `name`, `scenarioId`, `personalityId`, `path`)
- `DELETE /eval/simulation/:id` → `Simulation`

### Concurrency — `GET /eval/simulation/concurrency`

Returns the org's voice-simulation concurrency budget:

```jsonc
{
  "orgId": "uuid",
  "concurrencyLimit": 20,        // total call slots; voice sims use 2 each (tester + target)
  "activeSimulations": 6,         // call slots in use right now
  "availableToStart": 7,          // (concurrencyLimit - activeSimulations) / 2
  "createdAt": "2026-04-01T...",
  "updatedAt": "2026-04-15T...",
  "isDefault": true               // true if no override row → using platform default
}
```

> Voice simulations consume **two** call slots each (one for the tester, one for the target). Chat-mode simulations don't pull from voice concurrency in the same way — see existing gotchas section above.

---

## Scenarios (`/eval/simulation/scenario`)

### Create scenario — `POST /eval/simulation/scenario`

```jsonc
{
  "name": "Health Enrollment - Eligible Path",     // required, max 80
  "instructions": "You are calling to enroll...",  // required, max 10000
  "evaluations": [                                 // required, min 1
    {
      "structuredOutputId": "uuid",                // OR structuredOutput inline (exactly one)
      "comparator": "=",                           // = != > < >= <=
      "value": true,                               // string | number | boolean
      "required": true                             // optional, default true
    }
  ],
  "hooks": [                                       // optional; voice sims only
    { "on": "call.started", /* ... */ },
    { "on": "call.ended",   /* ... */ }
  ],
  "targetOverrides": {                             // optional AssistantOverrides
    "variableValues": { "customerName": "Alice" }
  },
  "toolMocks": [                                   // optional
    { "toolName": "lookupAccount", "result": "...", "enabled": true }
  ],
  "path": "clients/acme"
}
```

**Evaluation rules** (enforced server-side):

- Inline `structuredOutput.schema.type` MUST be a primitive: `string`, `number`, `integer`, `boolean`. Objects and arrays are rejected.
- `comparator` allowed values depend on schema type: booleans/strings only support `=` and `!=`; numbers/integers support all six.
- Exactly one of `structuredOutputId` or `structuredOutput` per evaluation item.

**Response 201** — full `Scenario`.

### List / Get / Update / Delete

- `GET /eval/simulation/scenario` (query: `limit`, `page`, `idAny`, `name`)
- `GET /eval/simulation/scenario/:id`
- `PATCH /eval/simulation/scenario/:id` (any subset of the create fields)
- `DELETE /eval/simulation/scenario/:id`

---

## Personalities (`/eval/simulation/personality`)

### Create personality — `POST /eval/simulation/personality`

```jsonc
{
  "name": "Confused Carl",            // required, max 80
  "assistant": { /* CreateAssistantDTO */ },  // required — full assistant config
  "path": "personas/confused"
}
```

> Only `assistant.model.messages[0].content`, plus voice/model/transcriber, is used for the tester. Extra system messages are ignored. An `endCall` tool is auto-appended if missing. (See "How Personalities Work" above.)

**Response 201** — full `Personality`. Note `orgId` may be `null` for Vapi-provided defaults that are visible to all orgs.

### List / Get / Update / Delete

- `GET /eval/simulation/personality`
- `GET /eval/simulation/personality/:id`
- `PATCH /eval/simulation/personality/:id` — body fields all optional: `name`, `assistant`, `path`
- `DELETE /eval/simulation/personality/:id`

---

## Simulation Suites (`/eval/simulation/suite`)

### Create suite — `POST /eval/simulation/suite`

```jsonc
{
  "name": "Checkout Flow Tests",                 // required, max 80
  "simulationIds": ["uuid", "uuid"],             // required
  "slackWebhookUrl": "https://hooks.slack.com/...", // optional
  "path": "clients/acme"
}
```

**Response 201** — full `SimulationSuite` (privileged fields + `simulationIds`).

### List / Get / Update / Delete

- `GET /eval/simulation/suite` (query: `limit`, `page`)
- `GET /eval/simulation/suite/:id`
- `PATCH /eval/simulation/suite/:id` — `simulationIds` is **replace** semantics (not merge)
- `DELETE /eval/simulation/suite/:id`

---

## Simulation Runs (`/eval/simulation/run`)

This is the unified executor. A "run" is a batch — it expands into many `runItem`s (one per simulation × iteration).

### Create run — `POST /eval/simulation/run`

```jsonc
{
  "simulations": [
    // Mode A: existing simulation
    { "type": "simulation", "simulationId": "uuid" },

    // Mode B: existing scenario + inline personality (mix-and-match)
    {
      "type": "simulation",
      "scenarioId": "uuid",
      "personality": { /* CreatePersonalityDTO */ },
      "name": "Optional name"
    },

    // Mode C: fully inline
    {
      "type": "simulation",
      "scenario": { /* CreateScenarioDTO */ },
      "personality": { /* CreatePersonalityDTO */ }
    },

    // Mode D: expand a suite
    { "type": "simulationSuite", "simulationSuiteId": "uuid" }
  ],
  "target": {
    // discriminated by type
    "type": "assistant",   // OR "squad"
    "assistantId": "uuid"  // OR provide inline `assistant` (CreateAssistantDTO)
  },
  "iterations": 3,                          // optional, default 1
  "transport": {
    "provider": "vapi.websocket"            // OR "vapi.webchat"
  }
}
```

**Per-entry constraints**:

- For each of `scenario`/`personality`: pass **either** the ID **or** the inline object — never both.
- If `simulationId` is set, the inline / `scenarioId` / `personalityId` fields are ignored.
- `simulationSuite` entries are expanded server-side into one entry per simulation in the suite.

**Transport behavior**:

- `vapi.websocket` → full voice STT/TTS pipeline (use for latency, realistic eval)
- `vapi.webchat` → text-only (faster, cheaper); audio-only evaluations are auto-skipped (see chat-mode gotcha)

**Response 201** — `SimulationRun`:

```jsonc
{
  "id": "uuid",
  "orgId": "uuid",
  "status": "queued",                          // queued | running | ended
  "simulations": [...],                        // echoed back
  "target": {...},
  "iterations": 3,
  "transport": { "provider": "vapi.websocket" },
  "queuedAt": "2026-04-27T...",
  "startedAt": "2026-04-27T...",               // optional
  "endedAt": "2026-04-27T...",                 // optional
  "endedReason": "completed",                  // optional
  "itemCounts": {                              // aggregate of run items
    "total": 9, "passed": 7, "failed": 1,
    "running": 0, "queued": 0, "canceled": 1
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

### List runs — `GET /eval/simulation/run`

Query params:

| Param | Type | Notes |
|-------|------|-------|
| `limit` / `page` | int | Pagination |
| `status` | enum | `queued` / `running` / `ended` |
| `filterStatus` | enum | Aggregate result: `passed` / `failed` / `running` |
| `targetType` | enum | `assistant` / `squad` |
| `targetId` | uuid | Filter to runs against this target |

### Get / Cancel run

- `GET /eval/simulation/run/:id` → `SimulationRun`
- `PATCH /eval/simulation/run/:id` → cancels the run **and** all its queued items. No body required.

---

## Simulation Run Items (sub-resource of run)

Run items are system-managed — there's no create/update API for users; they're produced when a run starts.

### List run items — `GET /eval/simulation/run/:id/item`

Query params: `limit`, `page`, `simulationId`, `runId`, `status` (`queued` | `running` | `evaluating` | `passed` | `failed` | `canceled`).

### Get a run item — `GET /eval/simulation/run/:id/item/:itemId`

**Response** — `SimulationRunItem` is rich; the highlights:

```jsonc
{
  "id": "uuid",
  "orgId": "uuid",
  "runId": "uuid",
  "simulationId": "uuid",
  "scenarioId": "uuid",        // resolved at run creation
  "personalityId": "uuid",     // resolved at run creation
  "callId": "uuid",            // the call placed against the target
  "sessionId": "uuid",         // present for chat-mode runs
  "status": "passed",          // queued | running | evaluating | passed | failed | canceled
  "iterationNumber": 2,        // 1-indexed
  "queuedAt": "...", "startedAt": "...", "completedAt": "...",
  "failedAt": "...", "canceledAt": "...",
  "failureReason": "string up to 2000 chars",
  "configurations": { "transport": { "provider": "vapi.websocket" } },
  "metadata": {
    "assistant": { /* snapshot at run-creation time */ },
    "squad": { /* if target was a squad */ },
    "scenario": { /* snapshot */ },
    "personality": { /* snapshot */ },
    "simulation": { /* snapshot */ },
    "call": {
      "transcript": "string",
      "messages": [/* OpenAI-format messages */],
      "recordingUrl": "https://...",
      "monitor": { "listenUrl": "wss://..." }   // live-listen during run
    },
    "hooks": { /* per-event hook execution state */ }
  },
  "results": {
    "passed": true,
    "evaluations": [
      {
        "structuredOutputId": "uuid" /* or "inline" */,
        "name": "goal-achieved",
        "comparator": "=",
        "expectedValue": true,
        "extractedValue": true,
        "passed": true,
        "required": true,
        "error": "string",       // optional, on extraction failure
        "isSkipped": false,
        "skipReason": "string"   // e.g. "audio-only eval in chat mode"
      }
    ],
    "latencyMetrics": {
      "turnCount": 12,
      "avgTurn": 1850, "avgTranscriber": 320, "avgModel": 850,
      "avgVoice": 410, "avgEndpointing": 270   // all milliseconds
    }
  },
  "improvementSuggestions": { /* see generate endpoint below */ },
  "hooks": [/* call.started / call.ended hook configs */],
  "createdAt": "...", "updatedAt": "..."
}
```

> **Snapshots are immutable**. Editing the source scenario/personality after a run does NOT change historical run items — debug against the snapshot in `metadata`.

### Cancel a run item — `PATCH /eval/simulation/run/:id/item/:itemId`

Validates the item belongs to the run, then cancels the item. Returns the updated `SimulationRunItem`.

### Generate improvement suggestions — `POST /eval/simulation/run/:id/item/:itemId/generate`

AI-generates suggestions for failed items. Cached per item; pass `?force=true` to regenerate.

**Response**:

```jsonc
{
  "analysis": "Why the evaluations failed (summary)",
  "systemPromptSuggestions": [
    { "issue": "Agent didn't confirm identity", "suggestion": "Add a verification step..." }
  ],
  "toolSuggestions": [
    { "issue": "...", "suggestion": "..." }
  ],
  "scenarioSuggestions": [
    { "issue": "...", "suggestion": "..." }
  ],
  "suggestedSystemPrompt": "Full revised prompt if major changes are needed"  // optional
}
```

---

## AI Scenario Generation (`/eval/simulation/scenario/generate`)

### Generate scenarios — `POST /eval/simulation/scenario/generate`

Provide **exactly one** of `assistantId` or `squadId`:

```jsonc
{ "assistantId": "uuid" }
// OR
{ "squadId": "uuid" }
```

**Response 201**:

```jsonc
{
  "scenarios": [
    {
      "name": "Short descriptive name",
      "instructions": "Tester instructions",
      "category": "happy_path",          // happy_path | edge_case | failure_mode
      "reasoning": "Why this scenario is valuable"
    }
  ],
  "coverageNotes": "Summary of test coverage"
}
```

> The generator returns scenario *drafts* — they are **not** persisted. Take the output and `POST` to `/eval/simulation/scenario` to save the ones you want.

> Throws `400` if neither `assistantId` nor `squadId` is supplied; `404` if the referenced target doesn't exist in the caller's org. Also subject to a feature-flag gate (`simulationEnsureEnabled`) — `403` if simulations aren't enabled for the org.

---

## Auth, Scopes, and Errors

- **Bearer token**: any private API key, or an org-scoped JWT.
- **CASL subjects** used for authz:
  - Read/create/update/delete simulation, scenario, personality, suite → `TEST_SUITE`
  - Read/create/update run + run items → `TEST_SUITE_RUN`
- **403** if the org doesn't have simulations enabled (feature flag).
- **404** for any cross-org access attempt — the service filters by `orgId` from `RequestContext`, so foreign IDs look the same as missing IDs.
- **400** on validation: missing required fields, non-primitive eval schemas, `simulationId` *and* inline scenario together, etc.
