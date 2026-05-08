# Voice Providers — Field Cheat-Sheet

The `voice` block on an assistant or `membersOverrides.voice` on a squad is **provider-specific**. Same conceptual field (e.g. "speed") lives at different paths depending on the provider. The Vapi platform rejects misplaced fields with a generic `property X should not exist` 400 — it does not point to the correct path. This page is the lookup table.

> **When a 400 says "property X should not exist":** check this page for the provider's field layout before re-pushing. The engine has no schema awareness and will accept whatever you write, then surface the error only after the push reaches the API.

---

## Quick lookup

| Field | 11labs | Cartesia (sonic-3) | OpenAI / Azure / Rime / LMNT / Minimax / Neuphonic / SmallestAI |
|-------|--------|---------------------|------------------------------------------------------------------|
| Speech rate | `voice.speed` (0.7–1.2) | `voice.generationConfig.speed` (0.6–1.5) | `voice.speed` |
| Stability / consistency | `voice.stability` (0.0–1.0) | — (not exposed) | — |
| Voice similarity | `voice.similarityBoost` (0.0–1.0) | — | — |
| SSML parsing | `voice.enableSsmlParsing: true` | (parsed natively, no flag) | varies — see provider docs |
| Pronunciation dictionary | `voice.pronunciationDictionaryLocators[]` (array of `{pronunciationDictionaryId, versionId}`) | `voice.pronunciationDictId` (single string id; not in Vapi docs but accepted as a Cartesia passthrough) | — |
| Volume control | — | `voice.generationConfig.volume` (0.5–2.0) | — |
| Emotion / accent (experimental) | — | `voice.experimentalControls.emotion`, `voice.experimentalControls.speed` (-1 to 1, older API) | — |

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

> **Public-docs note:** As of 2026-05-08 the public Vapi docs state pronunciation dictionaries are "exclusive to ElevenLabs voices." This is out of date — Cartesia has been confirmed in production deployments and Vapi-voice schema-level support is in active rollout (PRISM-474). Treat this wiki as the more current source.

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
- **Dashboard UI surface**: in active rollout (PRISM-474, Q2 2026). Schema acceptance does **not** guarantee runtime TTS engine honors the dictionary.
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
