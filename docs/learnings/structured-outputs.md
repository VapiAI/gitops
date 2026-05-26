# Structured Output Gotchas

Non-obvious behaviors and silent defaults for Vapi structured output extraction.

---

## Schema Type Gotchas

### Use single `type` values, not arrays

**Bad:** `type: [string, "null"]` — using an array for `type` is not supported and may cause errors in the dashboard and extraction pipeline. Vapi uses only the **first** element of the array.

**Good:** `type: string` — express nullability in the `description` instead (e.g., "Return null if not applicable").

### Primitive schemas are auto-wrapped

Primitive schemas (`string`, `boolean`, `number`) are automatically wrapped in an object for OpenAI structured output mode:
```json
{ "type": "object", "properties": { "value": <your schema> }, "required": ["value"], "strict": true }
```

The result is unwrapped before being returned. This is transparent but can cause confusion if you inspect raw API calls.

### `structuredOutput.name` is limited to 1-40 characters

The Vapi API enforces a hard 40-character maximum on the `name` field of any structured output (including inline structured outputs used inside scenario evaluations). Names longer than 40 chars fail at push time with:

```
POST /eval/simulation/scenario → 400
evaluations.5.structuredOutput.Name must be between 1 and 40 characters
```

Long, descriptive evaluator names like `assistant_left_voicemail_and_ended_call_promptly` (48 chars) or `assistant_detected_hostile_recording_and_ended_call` (51 chars) will silently exceed the limit until you POST. Keep names compact (`assistant_ended_call_after_message`, `assistant_handled_hostile_recording`) and put the descriptive nuance in the `description` field, which has no length cap. The constraint applies to the field on every structured output type — both standalone resources and inline evaluations within scenarios.

### Renaming a structured-output file is safe — the engine dedups by `name`

Same dedup behavior as for tools: if you rename a structured-output file but keep its `name` field stable, the push pipeline detects the existing dashboard resource (by slugified `name` against state and the live dashboard list) and adopts its UUID instead of creating a duplicate. You'll see `🔁 Reusing existing structured output: <localKey> → <uuid>` in the push log. See [tools.md → "Renaming a tool file is safe"](tools.md#renaming-a-tool-file-is-safe--the-engine-dedups-by-functionname) for the full mechanism, ambiguity warning semantics, and `npm run cleanup` workflow — they're identical for SOs.

---

## assistant_ids Must Be UUIDs

Structured outputs require `assistant_ids` as **Vapi UUIDs** (v4 format). Assistant **names** are not resolved here — unlike squad handoff destinations.

**Note:** The gitops engine resolves local filenames to UUIDs during push, so in your YAML you can use filenames. But if you're calling the API directly, use UUIDs.

---

## Default Extraction Model

If you omit `model` on a structured output, the default (as of this writing) is:
```yaml
model:
  provider: openai
  model: gpt-4.1-2025-04-14
  temperature: 0
  maxTokens: 4000
```

Fallback sequence: your configured model → `gpt-4.1` → `gemini-2.5-flash`. These defaults may change over time — check the API reference for the current default.

For multimodal extraction (`messages-with-audio`), the default is **Gemini 2.5 Pro** (as of this writing).

---

## target: messages vs messages-with-audio

- `messages` (default): LLM analyzes the full message history JSON. The default prompt injects `{{messages}}`, `{{callEndedReason}}`, and `{{structuredOutput.schema}}`.
- `messages-with-audio`: LLM analyzes both messages and the call recording. Requires `recordingUrl` to exist. If recording is disabled or unavailable, extraction fails with an error.

---

## Common KPI Patterns

Structured outputs are the primary way to measure voice agent performance. Common schema patterns:

| KPI | Schema type | Description |
|-----|------------|-------------|
| `call_successful` | `boolean` | Did the call achieve its primary goal? |
| `appointment_booked` | `boolean` | Was an appointment scheduled? |
| `caller_sentiment` | `enum: [positive, neutral, negative]` | Overall caller mood |
| `escalation_reason` | `string` | Why the call was escalated, if applicable |
| `topics_discussed` | `array of strings` | What subjects came up |
| `call_success_rate` | Aggregated from `call_successful` | Percentage of calls achieving their goal |
| `request_success_rate` | Aggregated per-request | Percentage of individual requests completed |

**Tip:** Start with 2–3 boolean KPIs (`call_successful`, `appointment_booked`) before adding more complex extraction. Each additional field increases extraction cost and latency.

---

## Squad `membersOverrides` vs standalone structured outputs

**What you might expect:** Linking structured outputs in `artifactPlan.structuredOutputIds` is enough for every call path in a squad.

**What actually happens:** Standalone structured-output resources run against the call transcript when listed on the assistant/squad artifact plan. **`analysisPlan.structuredDataPlan`** (inline schema + messages on the assistant or squad) is a separate end-of-call extraction path. In multi-agent squads, calls that end on an early member (voicemail leaver, silent classifier) often **never had** `structuredDataPlan` on that member — only the final conversational member did — so KPI fields stay empty even when the call succeeded.

**Recommendation:** For squad-wide KPIs that must populate on **every** ending (VM-only, classifier-only, and live-agent), use **`squad.membersOverrides.analysisPlan.structuredDataPlan`** plus **`membersOverrides.artifactPlan.fullMessageHistoryEnabled: true`**. Remove per-assistant duplicate plans. Keep standalone structured outputs for evals, dashboard analytics, or schemas you want versioned as separate resources.

Full YAML pattern and merge-order notes: [squads.md → Squad-level post-call extraction via `membersOverrides`](squads.md#squad-level-post-call-extraction-via-membersoverrides-multi-member-squads).
