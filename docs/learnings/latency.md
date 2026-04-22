# Latency Optimization

How to build voice agents that feel responsive. The target for natural-feeling conversation is **sub-500ms** from when the user stops speaking to when the agent begins responding.

---

## The Latency Budget

Every voice turn passes through four stages. Allocate your 500ms budget across them:

| Component | Budget | What it does |
|-----------|--------|--------------|
| VAD / Endpointing | ~100ms | Recognizing the user finished their turn |
| STT (Speech-to-Text) | ~150ms | Delivering the final transcript |
| LLM (Time to First Token) | ~150ms | Beginning response generation |
| TTS (Time to First Audio Byte) | ~100ms | Starting audio output |
| **Total** | **~500ms** | |

If any single component exceeds its budget, the caller perceives dead air.

---

## Quick-Win Optimization Matrix

| Optimization | Typical Savings | Effort |
|-------------|----------------|--------|
| Region pinning + TLS reuse | 40–100ms | Low |
| Single-codec telephony path | 100–300ms | Medium |
| Streaming STT with tight timeouts | 150–400ms | Medium |
| Token-streaming LLM | 100–300ms | Medium |
| Warmed, cached TTS | 100–200ms | Low |
| Async DB/API calls in tools | 50–200ms | Low |

---

## The Iron Triangle

You can optimize for two of three, but not all:

- **Latency** — speed and responsiveness
- **Intelligence** — reasoning capability and accuracy
- **Cost** — price per minute

Choose based on your use case:
- Simple appointment reminder → prioritize low latency + low cost
- Complex support agent → prioritize intelligence, accept slightly higher latency
- High-volume outbound campaign → prioritize cost, accept simpler models

---

## Model Selection

Match model intelligence to task complexity:

| Task complexity | Recommended models | Why |
|----------------|-------------------|-----|
| Simple (booking, FAQ, routing) | GPT-4.1-mini, Gemini Flash | Fast TTFT, low cost |
| Medium (support, qualification) | GPT-4.1, Claude Sonnet | Good balance of speed and reasoning |
| Complex (technical support, multi-step reasoning) | GPT-4.1, Claude Opus | Best accuracy, higher latency |

Using a frontier model for a simple task adds unnecessary latency and cost without improving outcomes.

**Pin your model version** (e.g., `gpt-4.1-2025-04-14`) to avoid unexpected behavior changes when providers update their models.

---

## Prompt Optimization for Latency

The system prompt is loaded into the LLM's context on every turn. A bloated prompt directly increases Time to First Token.

- **Keep it lean** — remove instructions that apply in fewer than 5% of calls. Handle rare cases through workflow nodes or tools instead.
- **Use structured context, not raw history** — extract key entities into a structured block rather than replaying the full transcript.
- **Pre-fetch and cache** — inject frequently needed data (company info, product catalog) via context variables rather than calling tools on every call.
- **Trim conversation history** — send only the most recent N turns rather than the full transcript.
- **Set temperature low** (0–0.3) — higher temperatures lead to longer, more variable outputs.

### The Prompt Latency Test

Before deploying, measure your prompt's impact:

1. Measure TTFT with your full system prompt
2. Remove sections one at a time and re-measure
3. Identify which sections add the most latency
4. Refactor or remove high-cost, low-value sections

---

## Endpointing Optimization

Poor endpointing is the most common cause of agents feeling "slow" or "rude."

- **Too aggressive**: cuts the user off mid-sentence
- **Too lazy**: forces the user to sit through dead air

For English, use [LiveKit Smart Endpointing](https://docs.vapi.ai/customization/voice-pipeline-configuration#smart-endpointing) with a wait function:

| Profile | Behavior |
|---------|----------|
| Aggressive | Fast response, may cut off longer utterances |
| Normal | Balanced — good default |
| Conservative | Waits longer, better for complex answers |
| Custom | Mathematical expression based on speech completion probability |

See [assistants.md](assistants.md) for `waitSeconds` vs `smartEndpointingPlan` interaction details.

### Deepgram Flux: eager end-of-turn for sub-budget LLM time

If you're already pushing latency budgets on Deepgram Nova-3, switching to a Flux model (`flux-general-en` / `flux-general-multi`) and setting `eagerEotThreshold` lets the LLM begin generating *before* the user fully stops speaking. Deepgram emits an `EagerEndOfTurn` event below the EOT confidence threshold so Vapi can speculatively start the LLM call; a later `TurnResumed` cancels the speculation if the user keeps talking.

Trade-off: more LLM calls (some get cancelled) for lower end-to-end latency on the turns that complete cleanly. Best for low-latency, high-volume agents that can absorb the extra LLM cost.

```yaml
transcriber:
  provider: deepgram
  model: flux-general-en
  eagerEotThreshold: 0.4   # earlier triggers, more cancellations
  eotThreshold: 0.7
```

See [assistants.md → Deepgram Flux](assistants.md) for the full field reference and gotchas (Vapi vs Deepgram range mismatches, no cross-field validation).

---

## Interruption Design (Barge-In)

Barge-in is not optional — it's a requirement for fluid conversation.

- Deliver information in short chunks, not monologues
- Confirm understanding before executing critical actions
- Target sub-200ms barge-in latency (from user speech to agent silence)
- Configure `stopSpeakingPlan.numWords` (default: 2) to control sensitivity

See [assistants.md](assistants.md) for `stopSpeakingPlan` defaults.

---

## TTS Selection for Latency

| Priority | Provider type | Examples |
|----------|--------------|---------|
| Lowest latency | Low-latency conversational voices | Cartesia Sonic-3, Vapi built-in, Deepgram Aura |
| Best quality | High-fidelity voices | ElevenLabs Multilingual v2, PlayHT |
| Best multilingual + pronunciation control | IPA dictionaries across all languages | Cartesia Sonic-3 with `pronunciationDictId` |

For conversation, **responsiveness almost always wins over voice quality**. A slight quality reduction that saves 100ms of Time to First Audio Byte is worth it in most use cases.

**Cartesia Sonic-3** is Vapi's default voice provider — sub-200ms latency across 42 languages with pronunciation dictionary support. For multilingual use cases needing pronunciation control, it's the strongest choice.
