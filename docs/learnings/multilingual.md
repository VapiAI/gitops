# Building Multilingual Voice Agents

Three architectural approaches for building voice agents that handle multiple languages, with provider recommendations and common pitfalls.

---

## Approach Comparison

|  | Single Static Agent | Two Agents with Handoff | Self-Handoff with Overrides |
|--|---------------------|------------------------|-----------------------------|
| **Complexity** | Low | Medium | High |
| **STT Accuracy** | Lower (multi-language tradeoff) | Highest (dedicated per-language config) | High (dedicated config via overrides) |
| **Latency** | None (no handoff) | ~50–200ms audio gap on handoff | Same as two-agent |
| **Tool messages** | Must use `contents[]` or single language | Each assistant has its own language | Same tools, `contents[]` with language variable |
| **Backend objects** | 1 assistant | 2 assistants | 1 assistant |
| **Best for** | Simple bilingual, code-switching OK | Distinct language experiences | Dynamic language config without duplicating assistants |

---

## Approach 1: Single Static Agent

Use one assistant with a multilingual transcriber and voice.

### Transcriber Options (English + Spanish)

| Provider | Config | How it works |
|----------|--------|--------------|
| **Deepgram** (recommended) | `language: "multi"` on nova-3 | Auto-detects per-utterance across supported languages |
| **Gladia** | `languageBehaviour: "automatic multiple languages"` | V2 solaria model with native code-switching |
| **Speechmatics** | `language: "en_es"` | Bilingual mode for Spanish+English |
| **AssemblyAI** | `language: "multi"` | Universal streaming multilingual model |

### Voice Options (Single Voice, Both Languages)

| Provider | Config | Notes |
|----------|--------|-------|
| **ElevenLabs** `eleven_multilingual_v2` | No language config needed | Auto-detects from text. Best quality. |
| **OpenAI TTS** | No config needed | Language inferred from text automatically |
| **Cartesia** `sonic-3` | `language: "es"` or `"en"` | `accentLocalization: 1` adapts accent to transcript language |
| **Azure** | `voiceId: "en-US-EmmaMultilingualNeural"` | MultilingualNeural voices handle multiple languages |

### System Prompt

```
You are a bilingual support agent fluent in English and Spanish.
Always detect the language the customer is speaking and respond
in that same language. If the customer switches languages
mid-conversation, follow their lead immediately.

Cultural guidelines:
- English: Direct, solution-focused, professional
- Spanish: Warm, use "usted" initially, build personal connection
```

### Limitations

- STT accuracy is lower with `"multi"` vs a dedicated language setting
- Tool messages, idle messages, and `endCallMessage` are static (single language) unless using `contents[]`
- No way to change voice mid-call without a handoff

---

## Approach 2: Two Agents with Handoff

Each assistant is fully configured for one language — dedicated transcriber, voice, system prompt, and tool messages.

### Architecture

```
[English Assistant] ←── handoff ──→ [Spanish Assistant]
   transcriber: en                    transcriber: es
   voice: en voice                    voice: es voice
   tools: English messages            tools: Spanish messages
   prompt: English                    prompt: Spanish
```

### Handoff Tool Configuration

```yaml
type: handoff
destinations:
  - type: assistant
    assistantId: other-language-assistant-id
    description: "Hand off when the caller switches to [other language]"
    contextEngineeringPlan:
      type: all
```

### Context Engineering Plan Options

| Type | Behavior | Best for |
|------|----------|----------|
| `all` (default) | Full conversation preserved, system message replaced | Continuing same conversation in new language |
| `none` | Clean slate | Starting fresh in new language |
| `lastNMessages` | Last N messages kept | Partial context preservation |
| `userAndAssistantMessages` | User/bot turns only (tool calls stripped) | Clean handoff without tool noise |

### firstMessage After Handoff

The destination assistant's `firstMessage` fires after handoff. Options:
- Set `firstMessage: ""` to suppress it
- Set it to a language-appropriate greeting: `"En que puedo ayudarle?"`
- Use `firstMessageMode: "assistant-speaks-first-with-model-generated-message"` for an LLM-generated greeting

### Advantages

- Highest STT accuracy: dedicated language per assistant
- Full control: each assistant has its own tool messages, voice, persona
- Tool messages naturally in the right language

### Disadvantages

- Two assistants to maintain
- ~50–200ms audio gap on handoff
- LLM must correctly detect language switches

---

## Approach 3: Self-Handoff with Variable Overrides

Single assistant hands off to itself with `assistantOverrides` to change language configuration at runtime.

### Handoff Destination

```yaml
type: handoff
destinations:
  - type: assistant
    assistantId: this-same-assistant-id
    description: "Switch to Spanish when the caller speaks Spanish"
    assistantOverrides:
      transcriber:
        provider: deepgram
        model: nova-2
        language: es
      voice:
        provider: eleven-labs
        voiceId: your-spanish-voice-id
        model: eleven_multilingual_v2
      variableValues:
        language: Spanish
        greeting: "En que puedo ayudarle?"
    contextEngineeringPlan:
      type: all
```

### What Can Be Overridden

Nearly any assistant property: `transcriber`, `voice`, `model.messages`, `firstMessage`, `variableValues`, `analysisPlan`, `tools:append`, and more.

To fully replace (not merge) a nested object like `transcriber`, provide the complete object — partial objects are deep-merged with the existing config.

### LiquidJS Template Variables

Fields that support `{{ variableName }}` substitution from `variableValues`:
- `firstMessage`, `voicemailMessage`, `endCallMessage`
- `messagePlan.idleMessages`, `endCallPhrases`
- `model.messages[*].content` (system prompt)
- Tool function names, descriptions, parameters, server URLs, headers, and messages
- `analysisPlan.*Prompt` fields

**NOT supported by templates:** `transcriber.language`, `voice.voiceId`, and other non-string config fields. These must be set via `assistantOverrides` directly.

### Caveats

- **No infinite loop protection**: if the LLM keeps triggering the handoff, it loops until `maxDurationTimeout`. Add clear prompt instructions: "Do not trigger language switch if already in the correct language."
- `firstMessage` fires on each swap (unless empty)
- Full pipeline teardown/rebuild on every self-handoff

---

## Tool Messages: The `contents[]` Pattern

Every tool message (`request-start`, `request-complete`, `request-failed`, `request-response-delayed`) supports per-language variants:

```yaml
# Single language (simple)
content: "Please hold while I look that up"

# Per-language variants (multilingual)
contents:
  - type: text
    text: "Please hold while I look that up"
    language: en
  - type: text
    text: "Un momento mientras busco eso"
    language: es
```

Vapi checks the active language and selects the matching variant. If no match is found, the first entry may be auto-translated.

**Caveat:** The active language is set once at call start from the transcriber config. With Deepgram `language: "multi"`, it defaults to `"en"`. This means `contents[]` may always select English unless the language is explicitly set via a handoff.

### Fields WITHOUT Per-Language Support

| Field | Workaround |
|-------|-----------|
| `firstMessage` | Use `{{ greeting }}` via `variableValues`, or `firstMessageMode: "assistant-speaks-first-with-model-generated-message"` |
| `endCallMessage` | Use `{{ endMessage }}` via `variableValues` |
| `voicemailMessage` | No template support |
| `messagePlan.idleMessages` | LiquidJS supported, but consider using hooks instead |

---

## Provider Recommendations (English + Spanish)

### Best Single-Agent Stack

```yaml
transcriber:
  provider: deepgram
  model: nova-3
  language: multi
  keyterm:    # Nova-3 multilingual supports keyterm since Nov 2025
    - your-brand-name
    - domain-specific-term

voice:
  provider: cartesia
  model: sonic-3
  voiceId: your-voice-id
  pronunciationDictId: pdict_xxx  # IPA works across all languages

model:
  provider: openai
  model: gpt-4.1
```

**Alternative voice:** ElevenLabs `eleven_multilingual_v2` if you need ElevenLabs-specific features (alias rules work across all languages, but IPA phoneme rules are English-only).

### Best Two-Agent Stack

```yaml
# English Assistant
transcriber: { provider: deepgram, model: nova-3, language: en }
voice: { provider: eleven-labs, voiceId: your-english-voice }

# Spanish Assistant
transcriber: { provider: deepgram, model: nova-3, language: es }
voice: { provider: eleven-labs, voiceId: your-spanish-voice }
```

---

## Common Pitfalls

| Pitfall | Root Cause | Solution |
|---------|-----------|----------|
| Agent understands Spanish but speaks English | TTS voice is English-only | Use multilingual TTS (Cartesia sonic-3, ElevenLabs multilingual_v2, OpenAI) |
| Tool messages always in English | Active language defaults to `"en"` with `"multi"` STT | Use `contents[]` with explicit language variants |
| Spanish STT accuracy worse than dedicated | Multi-language models trade accuracy for flexibility | Use dedicated per-language assistants (Approach 2) |
| Self-handoff infinite loop | LLM re-triggers handoff after seeing same conversation | Clear prompt: "Do not trigger language switch if already in correct language" |
| `firstMessage` not in detected language | `firstMessage` is a static string | Use LLM-generated first message or LiquidJS templates |
| Idle messages don't adapt | `messagePlan.idleMessages` has no `contents[]` | Use LiquidJS templates or hooks |

---

## Further Reading

- [Vapi Multilingual Documentation](https://docs.vapi.ai/customization/multilingual)
- [Vapi Multilingual Agent Example](https://docs.vapi.ai/assistants/examples/multilingual-agent)
- [Vapi Multilingual Squad Example](https://docs.vapi.ai/squads/examples/multilingual-support)
- [Vapi Handoff Tool Docs](https://docs.vapi.ai/squads/handoff)
