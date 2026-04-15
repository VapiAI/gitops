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

Simulations can target squads directly using `target.type: "squad"` with the squad ID:

```bash
curl -X POST "https://api.vapi.ai/eval/simulation/suite/{suiteId}/run" \
  -H "Authorization: Bearer $VAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target": {"type": "squad", "squadId": "your-squad-id"}, "transport": {"provider": "vapi.websocket"}, "iterations": 3}'
```

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
