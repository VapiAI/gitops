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
