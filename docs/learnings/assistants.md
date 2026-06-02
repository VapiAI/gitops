# Assistant Configuration Gotchas

Non-obvious behaviors and silent defaults for Vapi assistant settings.

---

## Model Defaults

### `temperature` defaults to 0, `maxTokens` defaults to 250

If omitted, Vapi defaults to `temperature: 0` and `maxTokens: 250`. This can cause unexpectedly short responses.

**Recommendation:** Set `maxTokens` explicitly (e.g., 1000–4000) for assistants that need longer responses.

### `numFastTurns` switches the model, not just latency

**What you might expect:** A latency optimization hint.

**What actually happens:** For OpenAI, `numFastTurns: N` switches the model to `gpt-3.5-turbo` for the first N conversational turns, then reverts to your configured model.

**Recommendation:** Only use this if you're comfortable with 3.5-turbo quality for early turns.

### `emotionRecognitionEnabled` has no runtime effect

Despite being a configurable field, this setting currently has **no effect** on call behavior. Don't rely on it.

### `gpt-5` is a reasoning model; `gpt-5-chat-latest` is the non-reasoning chat variant

OpenAI's `gpt-5` family on Vapi splits into two distinct shapes:

| Model ID | Behavior | Use it for |
|---|---|---|
| `gpt-5` | **Reasoning model.** Generates internal reasoning tokens before any user-visible output. Reasoning tokens are billed and **count against `maxTokens`**. | Tasks where multi-step deduction over the prompt is the goal. |
| `gpt-5-chat-latest` | **Non-reasoning chat variant.** Behaves like a standard chat completion. No hidden reasoning step. | Conversational SDR, tool-only triage, anything latency-sensitive. |

**The footgun:** `gpt-5`'s reasoning tokens are invisible in the assistant config but are deducted from your `maxTokens` ceiling. A tool-only assistant configured with `model: gpt-5, maxTokens: 60` may have only a handful of tokens left after reasoning to emit a tool call. Symptoms cluster:

- Model emits free-form text instead of the expected tool call ("voicing reasoning out loud") because the tool-call envelope can't fit in the leftover budget.
- When multiple tools are available, the model picks whichever has the cheapest argument shape (e.g. `dtmf` with `keys: "0w"` is ~5 output tokens; a handoff with a sentence-long `reason` is ~25+). This looks like the model is misclassifying the situation but is actually a budget-fit decision.
- The same prompt that worked correctly on `gpt-5-chat-latest` regresses to near-0% pass rate after a swap to `gpt-5` with no other config change.

**Diagnostic signal:** if a model with a clear, well-described tool list still picks the wrong tool *and* the prompt explicitly forbids the picked tool in that case, suspect output-budget exhaustion before you suspect the prompt. Reasoning tokens spent silently bias output toward whatever is shortest.

**Recommendation:**

- **Tool-only / triage / classifier assistants** (must emit a tool call, never TTS): use `gpt-5-chat-latest`. Reasoning capability buys nothing — the job is "match transcript pattern, emit tool call."
- **Conversational assistants where reasoning helps**: stick with `gpt-5-chat-latest` unless you have evidence reasoning is needed. If you do swap to `gpt-5`, set `maxTokens` to **at least 4–5x** the longest plausible visible response to leave headroom for the reasoning step. For a tool-only assistant, that means ≥150 even when the actual tool-call envelope is ~25 tokens.
- **Default for new assistants in this repo:** `gpt-5-chat-latest` matches what every non-classifier assistant uses. Picking `gpt-5` should be a deliberate choice with a documented reason, not the result of grabbing the shortest model name from the API enum.

---

## Voice Configuration

### Vapi-branded voices (`provider: 'vapi'`) need only a name

**What you might expect:** Like other voice providers, you'd need to specify a model, a long opaque voice ID, and possibly tune stability/similarity/speed knobs.

**What actually happens:** Vapi-branded voices are an abstraction. The complete config is just two fields:

```yaml
voice:
  provider: vapi
  voiceId: Elliot   # or any other Vapi voice name (Kylie, Clara, Spencer, etc.)
```

No model selection, no opaque voice ID, no chunk plan tuning required. The platform handles routing and automatically activates failover if the primary path errors mid-call.

**Recommendation:** When you don't have a hard requirement for a specific third-party voice, prefer a Vapi-branded voice. You get:

- A simpler, more readable yaml (one human-readable name)
- Automatic resilience — calls keep flowing through provider-side blips
- Forward-compatibility — voice quality improvements ship without yaml changes

**Optional knobs** (all default to sensible values):

| Field | Range | Notes |
|---|---|---|
| `speed` | 0.25–2 (default 1) | Effective range is clamped narrower than the input range; extreme values may not perceptibly differ from the limits |
| `language` | ISO 639-1 codes | Defaults to `en-US` |
| `pronunciationDictionary` | array of `{ pronunciationDictId, versionId? }` | Same dictionary IDs you'd attach to a direct-provider voice (see [Pronunciation dictionaries](#pronunciation-dictionaries-tts-level)) |

**Gotcha:** voice names are case-sensitive — `voiceId: 'elliot'` (lowercase) returns a 400 at config validation. The full list of valid names is visible in the Vapi dashboard's voice picker.

### `chunkPlan.enabled: false` can reduce latency

Disabling the chunk plan skips text formatting/preprocessing before TTS. This gives you raw LLM text (potentially with markdown or formatting artifacts) but lower latency.

### `inputPunctuationBoundaries` has multiple override layers

Priority order: top-level `inputPunctuationBoundaries` > `chunkPlan.punctuationBoundaries` > provider defaults. This means a top-level setting always wins over `chunkPlan`.

### Squad voice overrides **union-merge** punctuation boundaries

When merging voice overrides in squads, `inputPunctuationBoundaries` arrays are **unioned** (combined), not replaced. This can lead to more chunk boundaries than expected.

### Cartesia-specific config gotchas

Cartesia voices share the `voice` schema with other providers but reject several fields and require a few non-obvious nesting paths. Pushes fail with confusing 400s if you carry over an ElevenLabs config wholesale.

| Field | Behavior on Cartesia | Workaround |
|---|---|---|
| `enableSsmlParsing` | **Rejected** — ElevenLabs-only field | Omit it on Cartesia voice config |
| Top-level `voice.speed` | **Rejected** — must be nested | Use `voice.generationConfig.speed: 0.95` |
| Top-level `voice.stability` / `voice.similarityBoost` | Ignored — ElevenLabs-only | Omit; Cartesia tunes consistency through `generationConfig` knobs |
| `pronunciationDictId` | Supported on `sonic-3` only | Confirm `model: sonic-3` before attaching a dict |
| `accentLocalization` | Nested under `generationConfig.experimental` | `voice.generationConfig.experimental.accentLocalization: 1` |

```yaml
voice:
  provider: cartesia
  model: sonic-3
  voiceId: your-voice-id
  pronunciationDictId: pdict_xxxxxxxxxxxxx
  generationConfig:
    speed: 0.95
    experimental:
      accentLocalization: 1
```

### Cartesia Sonic-3 garbles em-dashes and SSML `<break>` tags

**What you might expect:** Em-dashes and `<break time='0.3s'/>` give you natural pauses, the same way they do on ElevenLabs.

**What actually happens:** Sonic-3's chunking pipeline mishandles both. Em-dashes can produce truncated or stitched audio (occasionally swallowing the next word), and explicit `<break>` tags inside Cartesia output sometimes mangle nearby phonemes. The failure mode is intermittent and shows up as "weird audio glitches" in QA.

**Recommendation:** When writing prompts for Cartesia Sonic-3, prefer commas, semicolons, and periods for pacing. If you're porting prompts from another TTS provider, search-and-replace `—` and `<break .../>` before pushing.

---

## Choosing the right pronunciation layer

Pronunciation problems live in two unrelated layers — picking the wrong one wastes a debugging cycle. Reproduce the failure first, then map symptom to layer.

| Symptom | Fix on | How |
|---|---|---|
| Word **misheard** by the agent (e.g. STT decodes "VAT" as "that") | Transcriber (input side) | `customVocabulary` (Soniox), `keyterm` (Deepgram). See [Transcriber Configuration](#transcriber-configuration) for syntax. |
| Word **mispronounced** by the agent (e.g. TTS reads "VAT" as "vee-ay-tee") | Voice / TTS (output side) | `pronunciationDictId` (Cartesia), `pronunciationDictionaryLocators` (ElevenLabs). See [Pronunciation dictionaries (TTS-level)](#pronunciation-dictionaries-tts-level) for the per-provider config. |

**Diagnostic question:** Did the transcript record what the user actually said?
- **No** — the STT got it wrong. Fix on the transcriber.
- **Yes, but the agent then said it wrong** — the TTS is mispronouncing. Fix on the voice.

Don't try both layers at once. They shape independent halves of the call and the wrong layer adds config noise without addressing the failure. For per-provider voice-side field shapes (Cartesia vs ElevenLabs vs Vapi), see [voice-providers.md → Pronunciation dictionary support](voice-providers.md#pronunciation-dictionary-support-per-provider-field-shapes).

---

## Transcriber Configuration

> **If a word is being misheard by the agent**, this is the right layer to fix it (input side). If a word is being mispronounced by the agent, fix the voice/TTS layer instead — see [Choosing the right pronunciation layer](#choosing-the-right-pronunciation-layer).

### Provider recommendations by language

| Language | Recommended Provider |
|----------|---------------------|
| English | Deepgram Flux General English (`flux-general-en`) |
| Spanish | Deepgram Nova-3 |
| Portuguese | Azure Transcriber |

For multilingual setups, see [multilingual.md](multilingual.md).

### Default STT for new demo assistants: Deepgram Flux General English

When spinning up a fresh English-language demo assistant, use Deepgram Flux General English by default. It is the baseline for first-pass/demo assistants because Flux gives better conversational turn handling than Nova-3, while still keeping the config simple.

```yaml
transcriber:
  provider: deepgram
  model: flux-general-en
  language: en
  numerals: true
  confidenceThreshold: 0.4
```

Only reach for Nova-3 when you have a specific reason, such as compatibility with an existing production assistant, a known Flux regression, or a non-demo flow whose current tuning is already validated.

### `confidenceThreshold` defaults to 0.4

If omitted, transcripts with confidence below 0.4 may be **ignored** entirely (not just flagged). This includes final transcripts, not just partials.

### Use Smart Denoising (Krisp) for background noise

[Smart Denoising (Krisp)](https://docs.vapi.ai/documentation/assistants/conversation-behavior/background-speech-denoising#smart-denoising-krisp) is recommended over [Fourier Denoising](https://docs.vapi.ai/documentation/assistants/conversation-behavior/background-speech-denoising#fourier-denoising-experimental) (experimental). Enable it via `backgroundDenoisingEnabled: true` or `smartDenoisingPlan.enabled: true`.

### Custom keyword/keyterm boosting

Boost domain-specific vocabulary with [Custom Keywords](https://docs.vapi.ai/customization/custom-keywords) to improve recognition of brand names, product names, and industry terms.

**Nova-3 uses `keyterm` (not `keywords`).** The legacy `keywords` field only works on Nova-2 and older models. For Nova-3, use `keyterm` — an array of words or multi-word phrases (no intensifiers). Supports up to 100 terms (~500 tokens).

**`keyterm` works in multilingual mode.** As of November 2025, `model: nova-3` with `language: multi` supports keyterm prompting. Previously this combination returned a 400 error.

```yaml
transcriber:
  provider: deepgram
  model: nova-3
  language: multi
  keyterm:
    - your-brand-name
    - industry-specific-term
    - product-name
    - technical-acronym
```

**Soniox supports the same idea as `customVocabulary`.** Soniox `stt-rt-v4` (a single universal model that handles all 60+ languages) accepts `customVocabulary: [...]` — an array of strings that biases recognition toward domain-specific terms. This is the Soniox equivalent of Deepgram `keyterm`, and unlike Deepgram nova-3, it works in multilingual mode without the English-bias caveat documented in [multilingual.md](multilingual.md). Pair with `languages: [en, es]` for code-switching plus vocabulary boost in the same call.

```yaml
transcriber:
  provider: soniox
  model: stt-rt-v4
  language: en
  languages: [en, es]      # optional; omit for single-language
  customVocabulary:
    - your-brand-name
    - industry-specific-term
    - product-name
    - tarjeta de combustible    # non-English equivalents are fine
  confidenceThreshold: 0.3
```

### Deepgram Flux: end-of-turn detection knobs

Vapi exposes all four of Deepgram Flux's end-of-turn detection parameters on the `transcriber` schema. They only apply when `model` starts with `flux-`.

| Vapi field | Deepgram param | Vapi range | Default |
|---|---|---|---|
| `eotThreshold` | `eot_threshold` | 0.5 – 0.9 | 0.7 |
| `eagerEotThreshold` | `eager_eot_threshold` | 0 – 1 | unset (eager mode disabled) |
| `eotTimeoutMs` | `eot_timeout_ms` | 500 – 10000 | 5000 |
| `languageHint` | `language_hint` | array of BCP-47 codes | unset |

**Dashboard exposes only `eotThreshold` and `eotTimeoutMs`.** `eagerEotThreshold` and `languageHint` are API-only fields — set them in your gitops yaml frontmatter and the engine PATCHes them straight through.

**`eagerEotThreshold` enables a separate event class.** Setting any value turns on Deepgram's `EagerEndOfTurn` events, which let the LLM start generating speculatively before the user fully stops (with `TurnResumed` cancellations if the user keeps talking). This is the main reason to use Flux over Nova-3 — see [latency.md](latency.md) for the trade-off.

**`languageHint` is silently dropped on non-`flux-general-multi` models.** No error — if you set it on `flux-general-en` it just won't apply.

**Vapi doesn't enforce Deepgram's `eager_eot_threshold ≤ eot_threshold` rule.** A bad combination passes Vapi validation and fails at the Deepgram websocket. Keep `eagerEotThreshold` strictly less than `eotThreshold`.

**Vapi's `eagerEotThreshold` validator is looser than Deepgram's.** Vapi accepts `0–1` but Deepgram only accepts `0.3–0.9`. Stay inside `0.3–0.9` to be safe.

```yaml
transcriber:
  provider: deepgram
  model: flux-general-en
  eotThreshold: 0.7
  eagerEotThreshold: 0.4
  eotTimeoutMs: 6000
```

Multilingual variant:

```yaml
transcriber:
  provider: deepgram
  model: flux-general-multi
  eotThreshold: 0.7
  languageHint:
    - en
    - es
```

See [Deepgram's Flux configuration guide](https://developers.deepgram.com/docs/flux/configuration) for tuning recommendations across simple / low-latency / high-reliability / complex-pipeline modes.

### Deepgram Flux: `smartEndpointingPlan` silently disables Flux's own EOT

**Critical gotcha — easy to miss, no warning emitted.** If you configure Deepgram Flux but also set `startSpeakingPlan.smartEndpointingPlan` (or the legacy `startSpeakingPlan.smartEndpointingEnabled`), Vapi will use that endpointing provider instead of Flux's `EndOfTurn` events. You'll pay for Flux, configure all the knobs, and get zero latency benefit from `eagerEotThreshold`.

**Why this happens:** Vapi's `EndpointingBuffer` only honors a transcriber's built-in EOT when `smartEndpointingPlan.provider` either matches the transcriber provider OR is unset. The valid `smartEndpointingPlan.provider` values are `vapi`, `livekit`, and `custom-endpointing-model` — `deepgram` is not a valid value, so the equality check is unreachable for Flux. The only way Flux's EOT fires is if `smartEndpointingPlan` is unset.

**It's especially insidious because LiveKit smart endpointing is commonly recommended elsewhere in Vapi guidance**, so customers tend to copy `smartEndpointingPlan: { provider: livekit }` forward when adding Flux. The override is silent — no error, no warning, no log line saying "Flux EOT ignored."

#### How each value behaves

| What you write | Wire validation | Effective result | Flux EOT fires? |
|---|---|---|---|
| Omit `smartEndpointingPlan` | passes | `undefined` | ✅ Yes |
| `smartEndpointingPlan: null` | passes | `undefined` | ✅ Yes |
| `smartEndpointingPlan: false` | likely 400 (validator expects an object with `provider`) | N/A | N/A — don't write this |
| `smartEndpointingPlan: { provider: vapi }` | passes | Vapi smart endpointing wins | ❌ No |
| `smartEndpointingPlan: { provider: livekit }` | passes | LiveKit endpointing wins | ❌ No |
| `smartEndpointingPlan: { provider: custom-endpointing-model }` | passes | custom server wins | ❌ No |
| `smartEndpointingEnabled: false` (legacy) | passes | normalized to `undefined` | ✅ Yes |
| `smartEndpointingEnabled: true` (legacy) | passes | normalized to `{ provider: vapi }` | ❌ No |
| `smartEndpointingEnabled: 'livekit'` (legacy) | passes | normalized to `{ provider: livekit }` | ❌ No |

**Dashboard "Off" option:** Selecting `Off` from the Smart Endpointing dropdown sets `smartEndpointingPlan` to `undefined` on the wire (not `false`, not `null`). That's the canonical "no smart endpointing" state.

#### Other `startSpeakingPlan` fields are safe to set

Only `smartEndpointingPlan` and `smartEndpointingEnabled` block Flux's EOT. The rest are unaffected on the Flux EOT path:

| Field | Effect on Flux EOT path |
|---|---|
| `waitSeconds` | Unrelated — applied in `turnTakingBuffer` as a post-VAD speaking cork. Safe to set. |
| `customEndpointingRules` | Bypassed when Flux EOT fires (no error, just dead weight in config) |
| `transcriptionEndpointingPlan` (punctuation timeouts) | Bypassed when Flux EOT fires |

#### Cleanest gitops yaml pattern for Flux

Just omit `smartEndpointingPlan` entirely. If you need to be explicit (e.g. overriding an inherited squad-level `smartEndpointingPlan`), set it to `null`:

```yaml
transcriber:
  provider: deepgram
  model: flux-general-en
  eagerEotThreshold: 0.4
  eotThreshold: 0.7

startSpeakingPlan:
  waitSeconds: 0.4
  smartEndpointingPlan: null   # explicit "let Flux handle EOT"
  # do NOT set smartEndpointingEnabled either
```

**Squad gotcha:** If your squad has `membersOverrides.startSpeakingPlan.smartEndpointingPlan`, that wins for every member regardless of what an individual assistant sets. Audit squad overrides before assuming a per-assistant `null` works.

### Pronunciation dictionaries (TTS-level)

> **If a word is being mispronounced by the agent**, this is the right layer to fix it (output side). If a word is being misheard, fix the transcriber instead — see [Choosing the right pronunciation layer](#choosing-the-right-pronunciation-layer). For per-provider voice-side field shapes, see [voice-providers.md → Pronunciation dictionary support](voice-providers.md#pronunciation-dictionary-support-per-provider-field-shapes).

Pronunciation dictionaries control how TTS voices say specific words. They are **provider-specific**:

| Provider | Support | Config field | Model requirement |
|----------|---------|-------------|-------------------|
| **Cartesia** | Full IPA + sounds-like across all languages | `pronunciationDictId` on voice config | `sonic-3` only |
| **ElevenLabs** | Phoneme rules (IPA/CMU, English only) + alias rules (all languages) | `pronunciationDictionaryLocators` on voice config | Alias: all models. Phoneme: model-dependent and silently no-op'd on most current models — see [voice-providers.md → ElevenLabs phoneme rule model compatibility](voice-providers.md#elevenlabs-phoneme-rule-model-compatibility). |
| **Vapi built-in** | None | N/A | N/A |

**Pronunciation dictionaries** are created via the Vapi API, then referenced by ID in the voice config. This is the same pattern as `credentialId` — the provider resource lives outside gitops, the reference is gitops-managed.

```yaml
voice:
  provider: cartesia
  model: sonic-3
  voiceId: your-voice-id
  pronunciationDictId: pdict_xxxxxxxxxxxxx
```

#### Cartesia CRUD

**Create** a new dictionary:

```bash
curl -X POST "https://api.vapi.ai/provider/cartesia/pronunciation-dictionary" \
  -H "Authorization: Bearer $VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Pronunciation Dictionary",
    "items": [
      { "text": "MyBrand", "alias": "my-brand" },
      { "text": "API", "alias": "ay pee eye" }
    ]
  }'
```

**Update** an existing dictionary — use `itemsToAdd` and/or `itemsToRemove`:

```bash
curl -X PATCH \
  "https://api.vapi.ai/provider/cartesia/pronunciation-dictionary/<vapi-resource-uuid>" \
  -H "Authorization: Bearer $VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "itemsToAdd": [{ "text": "NewTerm", "alias": "new-term" }],
    "itemsToRemove": ["OldTerm"]
  }'
```

**List** all dictionaries: `GET /provider/cartesia/pronunciation-dictionary`

**Delete** a dictionary: `DELETE /provider/cartesia/pronunciation-dictionary/<vapi-resource-uuid>`

**Gotcha — alias style matters:** Period-separated aliases (e.g. `"B. 2. B."`) create sentence boundaries in Cartesia Sonic-3, producing choppy pronunciation with micro-pauses. Use sounds-like aliases instead (e.g. `"bee to bee"`). This is the Cartesia-recommended approach for acronyms.

#### ElevenLabs CRUD

ElevenLabs dictionaries use `rules` instead of `items`. The `rules` field supports two rule types: `alias` (all models, all languages) and `phoneme` (IPA/CMU, English only, `eleven_turbo_v2` / `eleven_flash_v2`).

**Create** a new dictionary:

```bash
curl -X POST "https://api.vapi.ai/provider/11labs/pronunciation-dictionary" \
  -H "Authorization: Bearer $VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My ElevenLabs Dictionary",
    "rules": [
      { "string_to_replace": "MyBrand", "type": "alias", "alias": "my-brand" }
    ]
  }'
```

**Update** an existing dictionary — `rules` must be the **only** field in the body:

```bash
curl -X PATCH \
  "https://api.vapi.ai/provider/11labs/pronunciation-dictionary/<vapi-resource-uuid>" \
  -H "Authorization: Bearer $VAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rules": [
      { "string_to_replace": "NewTerm", "type": "alias", "alias": "new-term" }
    ]
  }'
```

**Gotcha — strict validation on PATCH:** If `rules` is missing, the API returns `"Rules are required to update a pronunciation dictionary"`. If any other fields are present alongside `rules`, it returns `"Only rules can be updated for a pronunciation dictionary"`.

**Recommendation:** For multilingual use cases, Cartesia sonic-3 with a pronunciation dictionary is the strongest option — IPA works across all languages. Combine with prompt-level pronunciation rules (belt-and-suspenders) and transcriber `keyterm` for a three-layer approach: TTS output, LLM text generation, and STT input.

### `smartEndpointingPlan` **owns** turn detection when set

If you configure `startSpeakingPlan.smartEndpointingPlan`, the transcriber's own `endpointing` settings (voice activity detection timeouts, etc.) are **not used** for turn detection. Smart endpointing takes full control.

**Recommendation:** Don't set both and expect them to combine. Choose one approach.

---

## firstMessage Modes

| Mode | Behavior |
|------|----------|
| `assistant-speaks-first` (default) | Uses the `firstMessage` text. TTS audio is pre-loaded for instant playback. |
| `assistant-speaks-first-with-model-generated-message` | Ignores `firstMessage`. The LLM generates the first message from `model.messages`. |
| `assistant-waits-for-user` | Bot stays silent until the user speaks. TTS for `firstMessage` is still pre-loaded in case it's needed later. |

**Gotcha:** `assistant-speaks-first-with-model-generated-message` is not supported by all realtime providers (e.g., Google Gemini Realtime will error).

### Outbound agents: use `assistant-waits-for-user` with empty `firstMessage`

For outbound voicemail detection agents that should never speak first:

```yaml
firstMessage: ""
firstMessageMode: assistant-waits-for-user
```

This makes the assistant listen silently when the call connects, allowing it to classify what picked up (voicemail, IVR, or human) before taking action.

**Gotcha:** Even in `assistant-waits-for-user` mode, TTS for `firstMessage` is still pre-loaded. Setting it to `""` avoids wasting TTS resources on unused audio.

### `voicemailMessage` is a separate safety net

`voicemailMessage` is spoken when Vapi's **built-in** voicemail detection triggers (separate from LLM-driven detection via the voicemail tool). It's a fallback mechanism — if your LLM-based detection misses a voicemail, this catches it.

**Recommendation:** Always set `voicemailMessage` on outbound agents as a last-resort safety net, even if your primary detection is LLM-based.

---

## Hooks

### Invalid hooks are silently skipped

Hooks that fail validation are dropped without error. Your call will proceed without them.

### Missing hook `toolId` is a warning, not an error

If a hook references a `toolId` that doesn't exist, Vapi logs a warning and continues. This is different from `model.toolIds` where a missing ID **errors the call**.

### Hook events are independent from timeout settings

`customer.speech.timeout` (hook) and `silenceTimeoutSeconds` (assistant) are separate mechanisms. The hook fires an action; the timeout ends the call. Configure them independently.

### Assistant top-level `name` is limited to 1-40 characters

The Vapi API enforces a hard 40-character maximum on the top-level `name` field of an assistant resource. Push-time error:

```
PATCH /assistant/<id> → 400
name must be shorter than or equal to 40 characters
```

This is **a separate field from `structuredOutput.name`** — both share the 40-char cap, but the enforcement sites are independent (see [structured-outputs.md](structured-outputs.md#structuredoutputname-is-limited-to-1-40-characters)). The constraint is not surfaced in the public schema reference; it's only enforced server-side at PATCH/POST time.

**Recommendation:** when generating descriptive assistant names from templates ("Triage Classifier — Multilingual Classic Variant" = 51 chars), trim before push or use shorter abbreviations. Put descriptive nuance in a comment in the YAML or in the system prompt body, not the `name` field.

### `silenceTimeoutSeconds` minimum is 10

The Vapi API enforces a hard minimum of **10 seconds** on `silenceTimeoutSeconds`. Setting this field to anything less than 10 (e.g., `5` or `8`) will fail at push time with:

```
PATCH /assistant/<id> → 400
silenceTimeoutSeconds must not be less than 10
```

The minimum is not documented in the gitops engine README and is only surfaced when you POST/PATCH. If you need an "end the call almost immediately" pattern (e.g., a voicemail-leaver that should fire `end_call` right after delivering its request-start message), drive that behavior through the assistant's prompt + `firstMessageMode: assistant-speaks-first-with-model-generated-message` + `endCallFunctionEnabled: true` so the model fires the end-call tool on activation. The 10-second timeout is then just a safety net, not the primary exit path.

### Available hook events

- `call.ending` — call is about to end
- `assistant.speech.interrupted` — assistant was interrupted
- `customer.speech.interrupted` — customer was interrupted
- `customer.speech.timeout` — customer hasn't spoken for N seconds
- `model.response.timeout` — model hasn't responded
- `assistant.transcriber.endpointedSpeechLowConfidence` — low-confidence transcript
- `call.timeElapsed` — N seconds since call start

---

## PATCH /assistant/:id semantics: shallow replacement at the top-level field

`PATCH /assistant/:id` is partial-update at the **top level only** — fields not in the request body stay untouched. But within each field you DO send, replacement is **wholesale, NOT deep-merged**. `PATCH { hooks: [oneNewHook] }` leaves the assistant with exactly one hook even if it had three before.

The same shallow-replace rule applies to: `model.messages`, `analysisPlan`, `voice`, `transcriber`, `messagePlan`, `serverMessages`, and any other object or array field. Whatever subtree you send overwrites the entire subtree on the resource.

**Safe-append pattern** — GET → mutate the returned array/object → PATCH the full structure back:

```yaml
# 1. GET /assistant/:id, capture existing.hooks
# 2. Append your new hook locally
# 3. PATCH with the full hooks array (existing + new)
hooks:
  - { ...existing hook 1 }
  - { ...existing hook 2 }
  - { ...new hook you wanted to add }
```

**Important distinction:** this is the REST API PATCH semantic. It is **different** from `assistantOverrides` in squad configs, which **deep-merges** partial nested objects per [multilingual.md → What Can Be Overridden](multilingual.md#what-can-be-overridden). When working through `assistantOverrides`, partial subtrees compose with the base assistant's config; when working through PATCH, partial subtrees replace.

See also: [fallbacks.md](fallbacks.md#phone-number-fallback-hook) for the same gotcha applied to phone-number hooks.

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

- `waitSeconds` controls a short pause on assistant audio after voice activity is detected — it delays the assistant's response by that duration.
- `smartEndpointingPlan` controls how end-of-turn is detected — it determines when the user has finished speaking using an AI model or heuristic.

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

### `voiceSeconds` maximum is 0.5

The Vapi API enforces a hard maximum of **0.5 seconds** on `stopSpeakingPlan.voiceSeconds`. Setting this higher (e.g., `0.75` or `1.0`) fails at push time with:

```
PATCH /assistant/<id> → 400
stopSpeakingPlan.voiceSeconds must not be greater than 0.5
```

The cap is undocumented in the schema reference but enforced server-side. When widening barge-in tolerance for assistants that handle continuous speech (voicemail prompts, IVR menus, fast personas), `numWords` is the load-bearing knob — `voiceSeconds` can only be tightened up to the cap (default 0.2 → max 0.5). For example, on a Soniox-transcribed classifier handling voicemail audio, `numWords: 5` does most of the work; `voiceSeconds: 0.5` is just a tighter ceiling.

### `numWords: 2` produces a 500–800ms TTS overlap window

**Why this matters for transcript quality, not just feel:** While the assistant waits for the second word to land before stopping, both speakers are talking simultaneously. That overlap window is typically **500–800ms** at conversational pace. STT confidence drops sharply during overlap, so the customer's first sentence after a barge-in often arrives garbled — wrong words, dropped clauses, or low-confidence transcripts that get filtered out (see `confidenceThreshold` above).

**Recommendation:** For barge-in-heavy use cases (objection handling, fast-paced dialogue), use `numWords: 1` and lean on Krisp denoising (`backgroundDenoisingEnabled: true`) to keep the assistant's own audio out of the customer's transcript. The trade-off is slightly more "false interrupts" on filler words like "um" or "yeah", which is usually preferable to garbled customer turns.

```yaml
stopSpeakingPlan:
  numWords: 1
  voiceSeconds: 0.2
  backoffSeconds: 1.0
backgroundDenoisingEnabled: true
```

---

## Analysis & Artifacts

### Summary is enabled by default

Unless you explicitly set `analysisPlan.summaryPlan.enabled: false`, post-call summaries are generated automatically.

### Recording is enabled by default

Unless you set `artifactPlan.recordingEnabled: false`, calls are recorded. Vapi also checks `assistant.recordingEnabled` (deprecated) before defaulting to `true`.

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

When HIPAA is enabled (on org or assistant) and HIPAA provider validation is enforced for your org, the model, voice, and transcriber providers must be on Vapi's approved allowlist. Non-compliant providers will **fail validation** on create/update.

---

## Tool Resolution (toolIds vs inline)

### Resolution order

1. Inline `model.tools` are processed first
2. Each `toolId` is resolved from the org's saved tools — **a missing ID errors the call**
3. Results are merged: `[...inline tools, ...resolved toolIds]`
4. MCP tools are expanded from configured integrations

### `toolIds` and inline `tools` can coexist

They are merged, not mutually exclusive. But be aware of potential duplicates.

---

## Liquid Variable Bag and Trust Tiers

Cross-reference: [docs.vapi.ai/assistants/dynamic-variables](https://docs.vapi.ai/assistants/dynamic-variables). The trust-tier framing came out of progressive caller-ID auth work on a customer rollout.

Vapi exposes a Liquid templating layer in prompts, tool config, and overrides — `{{ customer.number }}`, `{{ now }}`, etc. The variables in scope at runtime fall into three trust tiers based on where they originate. This matters because anything you place in a security-sensitive field (tool static `parameters`, message templates that go to a backend) is only as trustworthy as the source of the variable.

### Tier 1 — Server-trusted (safe for static `parameters` as a security boundary)

Populated from signaling, validated config, validated API call payloads, or the server clock. The LLM has no write path to these mid-conversation.

| Variable | Source |
|---|---|
| `{{ customer.number }}`, `{{ customer.sipUri }}` | SIP / Twilio signaling (inbound) or validated outbound API payload |
| `{{ customer.name }}`, `{{ customer.email }}`, `{{ customer.extension }}` | Validated outbound API payload (only if you set them server-side) |
| `{{ phoneNumber.number }}` | The Vapi number that placed/received the call |
| `{{ call.id }}`, `{{ call.type }}`, `{{ call.startedAt }}` | Server-set call state |
| `{{ now }}`, `{{ date }}`, `{{ time }}`, `{{ year }}`, `{{ month }}`, `{{ day }}` | Server clock at fulfill time |
| Custom keys set in `assistantOverrides.variableValues` at call start | Validated API call payload |

### Tier 2 — Conversation-derived (NOT a security boundary)

| Variable | Why unsafe |
|---|---|
| `{{ messages }}`, `{{ transcript }}` | Includes raw user transcripts |
| `{{ prompt }}` | Trusted at call-start, but pollutes if you template user input into it |

### Tier 3 — LLM- or extraction-derived (NEVER a security boundary)

| Variable | Why |
|---|---|
| `variableExtractionPlan` aliases | Only as trusted as the tool that produced them. An alias keyed on `{{ customer.number }}` is safe; one extracted from a tool whose response was shaped by user-spoken input is not. |
| Handoff-tool-extracted variables (`variableExtractionPlan.schema` on a handoff destination) | LLM extraction pass against the transcript |
| Handoff arguments (`function.parameters` on a handoff tool) | LLM-filled |

For the security-boundary use of Tier 1 variables in tool config, see [tools.md → Static `parameters` is the LLM-invisibility primitive](tools.md#static-parameters-is-the-llm-invisibility-primitive-security-boundary). For how the variable bag persists across squad handoffs, see [squads.md → Passing data between assistants](squads.md#passing-data-between-assistants).

### `{{ now }}` is UTC, hardcoded — use the `"now"` literal for timezone conversion

The `{{ now }}` variable is a pre-formatted string with " UTC" appended (e.g. `"Jan 1, 2024, 12:00 PM UTC"`). To render in another timezone, use the LiquidJS `date` filter with the literal string `"now"` — NOT the variable:

```liquid
{{ "now" | date: "%I:%M %p", "America/Los_Angeles" }}
```

**Common antipattern:** `{{ now | date: "...", "TZ" }}`. This pipes the pre-formatted UTC string through the filter, which fails because `date` cannot reparse Vapi's "Jan 1, 2024, 12:00 PM UTC" format reliably. The quoted `"now"` literal is the only form that works.

---

## Prompt Authoring

### Verbose negative-directive lists may prime the banned phrases

Long natural-language banlists in a system prompt ("never say 'X', 'Y', 'Z', …") are a plausible — though not deterministic — failure mode for output-leakage bugs. The intuition: every enumerated phrase is a token plant in the model's active context, and under output uncertainty (the rule says "stay silent," but the platform is asking for *some* output), recently-activated tokens can be over-sampled. The verbose ban can effectively serve as a verbose menu of likely outputs.

This is a tendency, not a determinism. Short, well-targeted banlists in well-constrained prompts work fine. The risk scales with banlist length AND with whether the same forbidden strings ALSO appear elsewhere in the prompt — e.g., as the example value of a tool-call argument the model is supposed to fill in. That overlap (same surface form appearing in both "do this" and "don't say this" slots) is the highest-risk pattern.

**Concrete failure pattern:** In one validation, a 50+ phrase ban list targeting voicemail edge cases regressed a sim-suite pass rate from 80% (12/15) to 20% (3/15). The model emitted nonsense single tokens that mapped to the banned-phrase region of the prompt — short fragments like one-word utterances ending in periods that didn't appear anywhere else in the conversation surface.

**Patterns practitioners prefer for hard "do not output X" guarantees:**

1. **Short, high-level safety directives** ("Do not output phone numbers") over enumerated bad strings. The model retains a principle better than a list, and a principle generalizes to phrasings the banlist would have missed anyway.
2. **Pattern-based constraints applied outside the prompt** — post-filters / regex on the assistant's `content`, structured output schemas (JSON mode, `tool_choice: required`), or platform-level content filters. These are deterministic; prompts are probabilistic. When the cost of a leak is real (PII, compliance, silent-classifier semantics), the enforcement should not live in the prompt.
3. **Separation of concerns between rule slots and example slots.** Don't place a string you forbid as the example value of a tool argument or a description field. If the argument needs an example, prefer a *shape* example over a literal that overlaps with banned content (e.g., `"e.g., a one- or two-word tag"` instead of `"e.g., 'live human pickup detected: hello?'"`).

**Recommendation in roughly this order:**
- If the platform exposes structured-output enforcement (`tool_choice: required`, response schemas, content filters), prefer that over prompt-only enforcement. Prompts are guidance; configuration is enforcement.
- Prefer a short *positive* directive ("emit empty `content`") over an exhaustive negative enumeration.
- Audit the prompt for any banned string that ALSO appears as an example or description value. Those overlap instances are higher-risk than abstract "never X" rules.
- If specific phrase bans are necessary, keep the list to 3–5 representative examples and rely on a principle clause ("…or any narration of your intent") rather than exhaustive listing.
- Validate prompt changes against a sim suite before rolling forward — verbose-ban regressions don't show up in single test calls; they require a few iterations of statistical signal to surface.
- This generalizes beyond voicemail: any "stay silent" / "don't say X" rule benefits from the four moves above.

Cross-reference: see [voicemail-detection.md](voicemail-detection.md) for the platform-level conflict that often motivates these prompt rules in the first place.
