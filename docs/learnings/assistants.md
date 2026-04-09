# Assistant Configuration Gotchas

Non-obvious behaviors and silent defaults for Vapi assistant settings.

---

## Model Defaults

### `temperature` defaults to 0, `maxTokens` defaults to 250

If omitted, the backend fills `temperature: 0` and `maxTokens: 250`. This can cause unexpectedly short responses.

**Recommendation:** Set `maxTokens` explicitly (e.g., 1000–4000) for assistants that need longer responses.

### `numFastTurns` switches the model, not just latency

**What you might expect:** A latency optimization hint.

**What actually happens:** For OpenAI, `numFastTurns: N` switches the model to `gpt-3.5-turbo` for the first N conversational turns, then reverts to your configured model.

**Recommendation:** Only use this if you're comfortable with 3.5-turbo quality for early turns.

### `emotionRecognitionEnabled` has no runtime effect

Despite being a configurable field, the endpointing buffer has an explicit no-op branch for this flag. Don't rely on it for behavior changes.

---

## Voice Configuration

### `chunkPlan.enabled: false` can reduce latency

Disabling the chunk plan skips text formatting/preprocessing before TTS. This gives you raw LLM text (potentially with markdown or formatting artifacts) but lower latency.

### `inputPunctuationBoundaries` has multiple override layers

Priority order: top-level `inputPunctuationBoundaries` > `chunkPlan.punctuationBoundaries` > provider defaults. This means a top-level setting always wins over `chunkPlan`.

### Squad voice overrides **union-merge** punctuation boundaries

When merging voice overrides in squads, `inputPunctuationBoundaries` arrays are **unioned** (combined), not replaced. This can lead to more chunk boundaries than expected.

---

## Transcriber Configuration

### `confidenceThreshold` defaults to 0.4

If omitted, transcripts with confidence below 0.4 may be **ignored** entirely (not just flagged). This includes final transcripts, not just partials.

### `smartEndpointingPlan` **owns** turn detection when set

If you configure `startSpeakingPlan.smartEndpointingPlan`, the transcriber's own `endpointing` settings (VAD timeouts, etc.) are **not used** for turn detection. Smart endpointing takes full control.

**Recommendation:** Don't set both and expect them to combine. Choose one approach.

---

## firstMessage Modes

| Mode | Behavior |
|------|----------|
| `assistant-speaks-first` (default) | Uses the `firstMessage` text. TTS audio is pre-loaded for instant playback. |
| `assistant-speaks-first-with-model-generated-message` | Ignores `firstMessage`. The LLM generates the first message from `model.messages`. |
| `assistant-waits-for-user` | Bot stays silent until the user speaks. TTS for `firstMessage` is still pre-loaded in case it's needed later. |

**Gotcha:** `assistant-speaks-first-with-model-generated-message` is not supported by all realtime providers (e.g., Google Gemini Realtime will error).

---

## Hooks

### Invalid hooks are silently skipped

Hooks that fail validation are dropped without error. Your call will proceed without them.

### Missing hook `toolId` is a warning, not an error

If a hook references a `toolId` that doesn't exist, the backend logs a warning and continues. This is different from `model.toolIds` where a missing ID **errors the call**.

### Hook events are independent from timeout settings

`customer.speech.timeout` (hook) and `silenceTimeoutSeconds` (assistant) are separate mechanisms. The hook fires an action; the timeout ends the call. Configure them independently.

### Available hook events

- `call.ending` — call is about to end
- `assistant.speech.interrupted` — assistant was interrupted
- `customer.speech.interrupted` — customer was interrupted
- `customer.speech.timeout` — customer hasn't spoken for N seconds
- `model.response.timeout` — model hasn't responded
- `assistant.transcriber.endpointedSpeechLowConfidence` — low-confidence transcript
- `call.timeElapsed` — N seconds since call start

---

## Idle Messages (messagePlan)

### Defaults

| Setting | Default |
|---------|---------|
| `idleTimeoutSeconds` | 10 |
| `idleMessageMaxSpokenCount` | 3 |
| `idleMessageResetCountOnUserSpeechEnabled` | **false** |
| `idleMessages` | empty (no idle messages) |

### `idleMessageResetCountOnUserSpeechEnabled` resets the **count**, not the timer

When true, user speech resets `idleMessageSpokenCount` back to 0 — so the assistant can cycle through idle messages again after the user re-engages.

### Idle messages are skipped during transfers and active tool calls

If a warm transfer is in progress or a tool call is executing, idle messages won't fire.

---

## Endpointing (startSpeakingPlan)

### `waitSeconds` defaults to 0.4s

If not set, there's a 0.4-second pause after the user stops speaking before the assistant responds.

### `waitSeconds` and `smartEndpointingPlan` control different things

- `waitSeconds` drives the **TurnTakingBuffer**: it corks assistant audio output for that duration after VAD detects speech.
- `smartEndpointingPlan` drives the **EndpointingBuffer**: it determines when the user has finished their turn using an AI model or heuristic.

These are complementary, not alternatives.

---

## Interruption (stopSpeakingPlan)

### Defaults

| Setting | Default |
|---------|---------|
| `numWords` | 2 |
| `voiceSeconds` | 0.2 |
| `backoffSeconds` | 1.0 |

`numWords: 2` means the user must speak 2 words before the assistant stops talking. Lower values make the assistant more interruptible.

---

## Analysis & Artifacts

### Summary is enabled by default

Unless you explicitly set `analysisPlan.summaryPlan.enabled: false`, post-call summaries are generated automatically.

### Recording is enabled by default

Unless you set `artifactPlan.recordingEnabled: false`, calls are recorded. The backend falls back to `assistant.recordingEnabled` (deprecated), then defaults to `true`.

### Default transcript labels are "AI" and "User"

Not the assistant's name. Override with `artifactPlan.transcriptPlan.assistantName` / `userName`.

---

## Background Sound & Denoising

### Phone calls default to `office` background sound, web calls to `off`

If `backgroundSound` is omitted, the default depends on the transport type.

### `backgroundDenoisingEnabled` is deprecated but still works

It maps to `smartDenoisingPlan.enabled`. The plan defaults to `true` if nothing says otherwise.

---

## Server Messages

### Default webhook events (sent when `serverMessages` is not set)

```yaml
- conversation-update
- end-of-call-report
- function-call
- hang
- speech-update
- status-update
- tool-calls
- transfer-destination-request
- handoff-destination-request
- user-interrupted
- assistant.started
```

Omitting `serverMessages` does **not** mean "no webhooks." It means "all defaults."

**Recommendation:** Set `serverMessages` explicitly if you want to reduce webhook noise.

---

## HIPAA / Compliance

When HIPAA is enabled (on org or assistant) **and** the `ENABLE_ASSISTANT_PROVIDER_HIPAA_VALIDATION` feature flag is active, the model, voice, and transcriber providers must be on an approved allowlist. Non-compliant providers will **fail validation** on create/update.

---

## Tool Resolution (toolIds vs inline)

### Resolution order

1. Inline `model.tools` are processed first
2. Each `toolId` is resolved from the org's saved tools — **a missing ID errors the call**
3. Results are merged: `[...inline tools, ...resolved toolIds]`
4. MCP tools are expanded from parent tool metadata

### `toolIds` and inline `tools` can coexist

They are merged, not mutually exclusive. But be aware of potential duplicates.
