# Voice Providers — Field Cheat-Sheet

The `voice` block on an assistant or `membersOverrides.voice` on a squad is **provider-specific**. Same conceptual field (e.g. "speed") lives at different paths depending on the provider. The Vapi platform rejects misplaced fields with a generic `property X should not exist` 400 — it does not point to the correct path. This page is the lookup table.

> **When a 400 says "property X should not exist":** check this page for the provider's field layout before re-pushing. The engine has no schema awareness and will accept whatever you write, then surface the error only after the push reaches the API.

---

## Quick lookup

| Field | 11labs | Cartesia (sonic-3) | Vapi-native (Clara, Elliot, Nico, etc.) | OpenAI / Azure / Rime / LMNT / Minimax / Neuphonic / SmallestAI |
|-------|--------|---------------------|-------|------------------------------------------------------------------|
| Speech rate | `voice.speed` (0.7–1.2) | `voice.generationConfig.speed` (0.6–1.5) | `voice.speed` | `voice.speed` |
| Stability / consistency | `voice.stability` (0.0–1.0) | — (not exposed) | — | — |
| Voice similarity | `voice.similarityBoost` (0.0–1.0) | — | — | — |
| SSML parsing | `voice.enableSsmlParsing: true` | (parsed natively, no flag) | **`enableSsmlParsing` REJECTED** — see notes below | varies — see provider docs |
| Pronunciation dictionary | `voice.pronunciationDictionaryLocators[]` (array of `{pronunciationDictionaryId, versionId}`) | `voice.pronunciationDictId` (single string id; not in Vapi docs but accepted as a Cartesia passthrough) | — (treat as unsupported until confirmed) | — |
| Volume control | — | `voice.generationConfig.volume` (0.5–2.0) | — | — |
| Emotion / accent (experimental) | — | `voice.experimentalControls.emotion`, `voice.experimentalControls.speed` (-1 to 1, older API) | — | — |

---

## 11labs

```yaml
voice:
  provider: 11labs
  voiceId: <uuid-or-name>
  model: eleven_turbo_v2          # or eleven_flash_v2_5
  speed: 1.05                      # 0.7–1.2
  stability: 0.6                   # 0.0–1.0; higher = less expressive variation
  similarityBoost: 0.75            # 0.0–1.0; higher = closer to source voice
  enableSsmlParsing: true          # required for `<break>`, `<flush/>`, etc.
  pronunciationDictionaryLocators: # ElevenLabs PLS dictionaries; multiple allowed
    - pronunciationDictionaryId: rjshI10OgN6KxqtJBqO4
      versionId: xJl0ImZzi3cYp61T0UQG
```

Common pitfalls:
- `voice.generationConfig.*` — **does not exist** for 11labs. That's a Cartesia path. Push will 400.
- Forgetting `enableSsmlParsing: true` — SSML tags will be spoken literally.
- `voice.pronunciationDictId` (single string) — that's the Cartesia shape. 11labs uses `voice.pronunciationDictionaryLocators[]` (array of `{pronunciationDictionaryId, versionId}`). Reference: <https://docs.vapi.ai/assistants/pronunciation-dictionaries>.

**Pronunciation dictionary warning (11labs):** dashboard edits that change the voice can drop `pronunciationDictionaryLocators` entries silently — the same drift class as Cartesia, just with the array shape. Treat the locators array as part of the voice's identity during edits.

---

## Cartesia (sonic-3)

```yaml
voice:
  provider: cartesia
  model: sonic-3
  voiceId: <uuid>
  pronunciationDictId: pdict_<id>  # optional but sticky — see warning below
  generationConfig:
    speed: 1.1                     # 0.6–1.5
    volume: 1.0                    # 0.5–2.0
  experimentalControls:
    speed: 0.0                     # -1 to 1 (older API path)
    emotion: ["positivity:high"]
```

**Forbidden at top level for Cartesia (will 400):**
- `voice.speed` — use `voice.generationConfig.speed` instead.
- `voice.enableSsmlParsing` — Cartesia parses SSML (`<break time='0.4s'/>`, `<speed ratio='0.9'/>`) natively from the text stream; no opt-in flag exists.
- `voice.stability`, `voice.similarityBoost` — those are 11labs fields.

**Pronunciation dictionary warning (Cartesia):** changing the `voiceId` in the Vapi dashboard's voice picker silently drops `pronunciationDictId` from the resource. If you swap the Cartesia voice via the dashboard, re-attach the dictionary on the next pull or it will be gone. Treat `(voiceId, pronunciationDictId)` as one atomic unit during edits. Note: `voice.pronunciationDictId` for Cartesia is observed in real customer payloads but is not in the Vapi docs (Vapi only documents the 11labs `pronunciationDictionaryLocators[]` shape — see the 11labs section above). Vapi appears to pass the field through to Cartesia's native API; behavior may change without notice.

---

## Vapi-native voices (Clara, Elliot, Nico, Emma, Neil, Sagar, Kai, Godfrey, Naina, Sid, Layla, Gustavo)

Vapi's first-party voice catalog wraps various TTS backends (Cartesia, ElevenLabs, others) behind a single `provider: vapi` alias. Which backend each named voice resolves to is **not publicly documented** — you can sometimes confirm by force-pulling an assistant that uses one (the pull engine occasionally resolves `vapi/<voiceId>` to the canonical provider name on the way back) or by inspecting the per-voice characteristics page in the Vapi voice docs.

```yaml
voice:
  provider: vapi
  voiceId: <voiceName>        # one of the Vapi catalog: Clara, Elliot, Nico, Emma, Neil, Sagar, Kai, Godfrey, Naina, Sid, Layla, Gustavo (grows over time)
  version: 2                  # opt in to Vapi Voices V2 where supported; voiceId stays the base name, e.g. Elliot
  speed: 1.05                 # top-level, 0.7–1.2 range observed
  chunkPlan:
    formatPlan:
      numberToDigitsCutoff: 10000   # numbers below this are spoken naturally; above are spelled digit-by-digit
  fallbackPlan:
    voices:
      - provider: 11labs
        model: eleven_turbo_v2_5
        voiceId: <fallback-voice-id>
```

**Vapi Voices V2:** for supported voices, opt in with `voice.version: 2`. Do **not** change the `voiceId` to a display label like `Elliot V2`; the API still expects the base enum value (`Elliot`) and returns `400 Bad Request` if the suffix is included in `voiceId`.

**Forbidden at top level for Vapi-native voices (will 400):**

- `voice.enableSsmlParsing` — API returns `400 Bad Request` with `"voice.property enableSsmlParsing should not exist"`. The field is **only valid on `provider: 11labs` voices**. Vapi-native voices do not expose an explicit SSML-parsing opt-in flag, even if the underlying backend (e.g. Cartesia sonic-3) parses SSML natively.
- `voice.stability`, `voice.similarityBoost` — those are 11labs fields and will 400 here too.
- `voice.generationConfig.*` — Cartesia path. Even if a Vapi-native voice wraps Cartesia internally, the `generationConfig` block is not exposed through the `provider: vapi` alias.

**Does SSML actually work without the flag?** Depends on the wrapped backend:

- If the Vapi voice wraps **Cartesia sonic-3**, SSML break tags work natively — Cartesia parses SSML from the text stream without an opt-in. Pause durations should approximate the declared values.
- If the Vapi voice wraps **11labs Turbo v2.5**, SSML break tags would require `enableSsmlParsing: true` — but the flag is rejected on the `provider: vapi` alias, so SSML effectively does not render through this path. To use SSML on an 11labs-backed voice, declare it explicitly as `provider: 11labs` with the matching `voiceId`.
- **Vapi's voice-formatting pipeline preserves `<break>`, `<spell>`, and `<<...>>` patterns through angle-bracket stripping** (the `removeAngleBracketContent` step has these as hardcoded exceptions — see `assistants/voice-formatting-plan` in the Vapi docs). So even when the wrapped backend doesn't render the tags, they don't leak as literal text either. Worst-case behavior is silent no-op, NOT audible regression like "the assistant says 'break time 350 milliseconds' out loud."

**Smoke-test protocol** when adding SSML pacing to a `provider: vapi` voice (or migrating from `provider: 11labs` to `provider: vapi`):

1. Push the new voice config to a non-prod sandbox assistant.
2. Place one call that elicits a 3+ item enumeration (e.g. "what features does X have?").
3. Listen for whether `<break time="..."/>` tags between list items render as audible pauses or get silently absorbed.
4. If absorbed and pauses are needed for naturalness, either (a) switch the primary voice to `provider: 11labs` explicitly (with `enableSsmlParsing: true`), (b) use Cartesia natively, or (c) rely on commas + sentence punctuation as the prosody mechanism (Cartesia sonic-3 renders commas as ~150–200ms pauses, which covers most sentence-internal pacing without SSML).

**Cross-reference:** the comma-as-micro-pause convention works on most TTS providers and is the recommended fallback for sentence-internal pacing when SSML support is unreliable. The SSML-only-for-lists convention works on Cartesia-wrapped Vapi voices but should be smoke-tested before relying on it for a production fleet.

---

## OpenAI / Azure / Rime / LMNT / Minimax / Neuphonic / SmallestAI

```yaml
voice:
  provider: openai           # or azure, rime, lmnt, minimax, neuphonic, smallestai
  voiceId: <provider-voice-id>
  model: <provider-model>    # e.g. tts-1-hd for openai
  speed: 1.0                 # top-level for these providers
```

These providers expose `speed` at the top of the `voice` block. Refer to the [Vapi voice provider docs](https://docs.vapi.ai/providers/voice) for additional provider-specific fields (instructions, language hints, etc.).

---

## Switching providers

When migrating an assistant or squad member from Cartesia to 11labs (or vice versa), the field layout flips. If you carry over `generationConfig` from a Cartesia config to an 11labs voice, the next push will 400. Always rewrite the voice block from the target provider's template; do not patch in place.

If a customer changes the provider on the dashboard and your local YAML still has the old nesting, `pull` will overwrite it cleanly — but a subsequent `push` from a stale branch will 400. Pull first, then edit.

---

## Adding a new provider

If you find yourself reaching for a provider not in the table above, append a row here in the same PR. The cheat-sheet only stays useful if it grows with the platform.

---

## Pronunciation dictionary support: per-provider field shapes

Pronunciation dictionaries do not share a field shape across voice providers. Same conceptual feature, three different surfaces.

> **Public-docs note:** As of 2026-05-08 the public Vapi docs state pronunciation dictionaries are "exclusive to ElevenLabs voices." This is out of date — Cartesia has been confirmed in production deployments and Vapi-voice schema-level support is in active rollout. Treat this wiki as the more current source.

### Cartesia

- **Field**: `voice.pronunciationDictId` — single string ID on the voice config.
- **Model requirement**: `model: sonic-3` only. Other Cartesia models silently ignore the field.
- **Upstream resource shape**: the Cartesia dictionary resource exposes a `name` field.
- **Full config example**: see [assistants.md → Pronunciation dictionaries (TTS-level)](assistants.md#pronunciation-dictionaries-tts-level).

### ElevenLabs

- **Field**: `voice.pronunciationDictionaryLocators` — array of `{ pronunciationDictionaryId, versionId? }`.
- **Model requirement**: alias rules work on all ElevenLabs models. **Phoneme rules are silently no-op'd** on `eleven_turbo_v2_5` (Vapi's default), `eleven_flash_v2_5`, `eleven_multilingual_v2`, and `eleven_v3`. See [ElevenLabs phoneme rule model compatibility](#elevenlabs-phoneme-rule-model-compatibility) below for the full breakdown.
- **Upstream resource shape**: the ElevenLabs dictionary resource exposes a `dictionaryName` field — **NOT `name`**. This trips up wrappers that fetch dictionaries via API and surface them in tools that also handle Cartesia.

### Vapi voices

- **Schema-level**: accepts pronunciation dictionary configs at the API.
- **Dashboard UI surface**: in active rollout. Schema acceptance does **not** guarantee runtime TTS engine honors the dictionary.
- **Phoneme rules don't work with Vapi proprietary voices.** The Vapi voice pipeline doesn't run on `eleven_flash_v2` (the only ElevenLabs model that honors phoneme rules — see [ElevenLabs phoneme rule model compatibility](#elevenlabs-phoneme-rule-model-compatibility) below), so any phoneme entries in your dictionary are silently ignored at runtime. **Use alias rules only when targeting Vapi proprietary voices.**
- **Recommendation**: verify runtime behavior with a call test before depending on it for production Vapi-voice deployments.

### Field shape gotcha

The three provider families do NOT use the same field name on the upstream pronunciation-dictionary resource:

| Provider | Upstream display-name field |
|---|---|
| Cartesia | `name` |
| ElevenLabs | `dictionaryName` |
| Vapi voices | shape pending finalization |

If you're authoring a wrapper or migration tool that handles all three, gracefully handle the divergence. A single `name`-only path will silently render ElevenLabs dictionaries with empty labels.

### ElevenLabs phoneme rule model compatibility

ElevenLabs splits pronunciation rules into two types:

- **Alias rules** — word substitution ("MyBrand" → "my-brand"). **Work universally** on all ElevenLabs models.
- **Phoneme rules** — exact pronunciation via IPA / CMU Arpabet. **Model-dependent.**

**Confirmed unsupported (silent no-op):**
- `eleven_turbo_v2_5` — Vapi's default ElevenLabs model
- `eleven_flash_v2_5`
- `eleven_multilingual_v2`
- `eleven_v3`

**Confirmed supported:**
- `eleven_flash_v2`
- Likely `eleven_monolingual_v1` (ElevenLabs docs disagree across pages on the exact set — verify before depending on it)

**Silent-skip behavior:** when a phoneme rule is sent to an unsupported model, ElevenLabs does NOT error. It bypasses the rule and uses standard pronunciation. **Customer impact:** attaching a phoneme-only dict to the default voice gets zero benefit with no signal — the call sounds exactly like the no-dict baseline.

**Workarounds:**
1. **Author dict as alias rules** — they work everywhere. Trade phoneme precision for portability.
2. **Pin to `eleven_flash_v2`** — explicit model lock if phoneme accuracy matters more than the latency profile of `eleven_turbo_v2_5` / `eleven_flash_v2_5`.

```yaml
# Phoneme-rule-dependent — pin the model
voice:
  provider: 11labs
  model: eleven_flash_v2
  voiceId: <your-voice-id>
  pronunciationDictionaryLocators:
    - pronunciationDictionaryId: <your-dict-id>
```

**Language constraint:** phoneme rules (both IPA and CMU Arpabet) **only apply to English text**. For non-English text in a multilingual deployment, ElevenLabs silently bypasses phoneme rules regardless of model — even on `eleven_flash_v2`. Use **alias rules** instead — they're language-agnostic at the substitution layer (the substituted text is then synthesized by the model in whatever language it's configured for). This makes alias rules the only viable pronunciation-dictionary path for non-English deployments.
