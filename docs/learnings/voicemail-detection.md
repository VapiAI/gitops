# Voicemail Detection

How to reliably detect voicemail, IVR systems, and live humans on outbound calls — and route accordingly.

---

## The Core Problem

When an outbound call connects, you don't know what picked up. It could be a human, a voicemail greeting, an IVR phone tree, a fax machine, or dead air. Your agent must classify the audio within seconds and take the right action — otherwise it either talks to a machine or hangs up on a person.

---

## Two Architectures: Single-Agent vs Two-Agent Relay

### Single-Agent Approach

One assistant handles detection, routing, and conversation. Simpler to maintain, but the detection logic competes with conversation logic in the same prompt.

**When to use:** Simple outbound campaigns where the agent's primary task is straightforward (e.g., confirming an appointment).

### Two-Agent Relay (Recommended for High Accuracy)

A silent "gatekeeper" assistant monitors the transcript and makes a single tool call (end call or hand off), then a second "fronter" assistant takes over the conversation.

```
Outbound Call
    │
    ▼
┌──────────────────────┐
│  VM Detection Agent   │  ← Silent. Never speaks.
│  (temperature: 0)     │     Monitors transcript.
│                       │
│  Voicemail → end call │
│  IVR → keep waiting   │
│  Human → hand off     │
└──────────┬────────────┘
           │ Human detected
           ▼
┌──────────────────────┐
│  Fronter Agent        │  ← Takes over. Speaks first
│                       │     via handoff tool message.
└──────────────────────┘
```

**When to use:** High-volume outbound campaigns where false positive/negative rates matter, or when detection accuracy directly impacts ROI.

**Why it works better:**
- Detection logic is isolated — `temperature: 0`, purely deterministic, no creative generation
- The fronter prompt is clean — optimized solely for conversation quality
- Each concern is independently testable and tunable

### ⚠️ Platform `voicemailDetection` MUST be disabled on the gatekeeper (Two-Agent Relay)

This is the single most non-obvious failure mode in two-agent voicemail relay setups. If the gatekeeper assistant has Vapi's platform `voicemailDetection: { provider: vapi }` configured, the call will **silently break on every voicemail** — the bot never speaks, the message never lands, the call ends with `endedReason: voicemail` after ~10–22s of dead air. We hit this on mudflap-test's iform voicemail triage squad on 2026-05-14 and only diagnosed it after pulling full Axiom event timelines.

**The mechanism (verified via call 019e2827 on 2026-05-14):**

1. The carrier prompt audio streams into the gatekeeper's transcriber (e.g. Soniox stt-rt-v4). Soniox emits a flood of `assistant.transcriber.partialTranscript` events.
2. Each partial transcript triggers a new `pipeline.turnStarted`, which calls `assistant.model.clearing` and emits `assistant.model.requestAborted` on any in-flight LLM request. The gatekeeper LLM never gets a stable 1–2 second window to complete a response.
3. **Meanwhile**, platform `voicemailDetection` runs the Vapi VMD classifier on the raw audio in parallel — it doesn't wait for the LLM. With `backoffPlan: { frequencySeconds: 2.5, maxRetries: 6, startAtSeconds: 2 }`, it fires `call.voicemailDetected` events starting at ~+5s into the call.
4. Platform VMD ends the call with `endedReason: voicemail` regardless of whether the LLM has emitted its handoff tool call. The gatekeeper LLM literally never finishes a `model.firstTokenReceived` event — every request gets aborted by streaming transcripts before completion.
5. Worse: if the gatekeeper has NO `voicemailMessage` field configured, platform VMD's "voicemail detected" outcome is to end the call **silently**. No callback message plays. The recording captures the carrier prompt + dead air.

**Architectural mismatch root cause:** Platform `voicemailDetection` + `voicemailMessage` is designed for the **single-agent** voicemail flow (platform detects → platform plays voicemailMessage → platform ends call). The two-agent relay's `handoff_to_voicemail_leaver` tool flow is a **competing detection path** that loses the race because:

- LLM-based detection requires the LLM to actually run to completion. Streaming transcripts during the carrier prompt prevent that.
- Platform VMD operates directly on audio, in parallel, and doesn't need the LLM.
- Without `voicemailMessage` on the gatekeeper, platform VMD's win = silent call end.

**Fix:** Disable platform `voicemailDetection` on the gatekeeper assistant. Either:

- **Recommended**: don't set the field at all on the gatekeeper. Multilingual triage classifiers that never had `voicemailDetection` configured (e.g. `iform-triage-classifier-multilingual-d98136d9`, `iform-triage-multilingual-classic-f6b53e27` on mudflap-test) work where same-shape squads with VMD-on classifiers failed.
- **If you can't modify the underlying assistant** (e.g. a customer is gatekeeping the base classifier UUID for another reason): fork the classifier and use the fork in the squad. `assistantOverrides.voicemailDetection: null` does **NOT** work — Vapi's API silently drops the field. Verified via direct PATCH test on 2026-05-14.
- **Never** set `voicemailDetection` on the gatekeeper AND rely on the handoff path. They are mutually exclusive architectures.

**Detection fallback when platform VMD is off:** The gatekeeper LLM's prompt is now the sole detector. Even with streaming-transcript aborts during the carrier prompt, the LLM eventually gets a stable window (the silence between carrier-prompt sentences, or after the prompt ends but before the beep) and emits its `handoff_to_voicemail_leaver` tool call. The leaver then speaks the callback message via the handoff's `request-start`.

**Engine-gap note for gitops users:** the `assistantOverrides.voicemailDetection: null` rejection is one of several Vapi-side override fields that silently drop a null in a squad-member override. If you're trying to "turn off" any nested-object field via override, verify with a direct GET after PATCH — don't trust that null made it through.

---

## The Detection Priority Hierarchy

Always evaluate in this order — voicemail signals are more urgent than human signals because acting late on voicemail wastes call minutes:

| Priority | Signal | Action |
|----------|--------|--------|
| 1 | Definitive voicemail phrases | `end_on_voicemail` immediately |
| 2 | Numbers-only transcript (carrier reading back a phone number) | `end_on_voicemail` immediately |
| 3 | Voicemail tail fragments (truncated phrases like "system.", "message.") | `end_on_voicemail` immediately |
| 4 | IVR menu language ("Press 1 for...") | Output nothing, keep monitoring |
| 5 | Human speech | `handoff_to_agent` immediately |
| 6 | Unintelligible audio | Output nothing, keep monitoring |

---

## Voicemail Trigger Phrases

### Definitive — Any One of These Means Voicemail

If any of these appear in the transcript (even across chunk boundaries), it's voicemail:

- "leave a message" / "leave your message" / "leave your name"
- "after the tone" / "at the tone" / "after the beep"
- "record your message" / "record your name"
- "voicemail" (the word itself)
- "mailbox" (the word itself)
- "you've reached" / "you have reached"
- "voice messaging system" / "messaging system"
- "not in service" / "has been disconnected" / "no longer in service"
- "cannot be completed as dialed"

### Contextual — Only Voicemail WITH Additional Evidence

These phrases share words with normal human speech and need corroboration:

| Phrase | Voicemail when... | Human when... |
|--------|-------------------|---------------|
| "not available" / "is unavailable" | Preceded by "The person", "The subscriber", "The customer" | Standalone or followed by conversational speech |
| "forwarded to" | Followed by "voicemail" or "automated voice messaging system" | Followed by a person's name or department |
| "We're sorry" | Followed by "no one available to take your call" | Followed by a name or interrupted by "Hello?" |

### Numbers-Only Transcripts

If the transcript is purely spoken digits ("4 7 1", "7 0 6", "3. 7 8") with no conversational words, it's a carrier reading back a phone number — treat as voicemail.

### Truncated Phrases

Streaming transcription can split a voicemail greeting across chunks. Treat clearly truncated phrases as matches: "you've reach", "leave a mess", "forwarded to voice".

---

## Human Detection Signals

### Short Utterances (Common Pickup Noises)

These single words/phrases almost always mean a human answered:

"Hello?" / "Yeah?" / "Hi" / "Hey" / "What?" / "Sorry" / "Okay" / "Huh?" / "Um"

### Conversational Speech

- Greetings: "Hello, this is [name]", "Good morning"
- Questions: "Who's calling?", "Can I help you?", "May I ask who's calling?"
- Business answers: "[Company name], how can I help you?"

### False Positive Prevention

These look like voicemail but are actually human:

| What you hear | Why it's human |
|---------------|---------------|
| "Hello? This is [name]. Sorry, I can't get to the phone right now." | Human apologizing — no definitive voicemail keyword |
| "We're sorry, [name]. Could not... Hello? Hello?" | Carrier fragment interrupted by live human pickup |
| "I can't do it right now." | Conversational refusal, not a recording |

**Key rule:** If the transcript contains "Hello?" with a question mark, a name introduction, or an interactive question — and NO definitive voicemail keyword — the caller is a live human.

---

## IVR Handling

IVR (Interactive Voice Response) systems are neither voicemail nor humans. Don't hang up — keep monitoring.

### IVR Indicators

- "Press 1 for..." / "Press 0 for operator"
- "For English, press 1. Para español, oprima el dos."
- "If you know your party's extension, dial it now"
- "Please listen carefully as our menu options have changed"

### What To Do

Wait silently. If a human pickup cue appears at any point, hand off. If a voicemail indicator appears, end the call. If the IVR eventually reaches voicemail, end the call.

See [outbound-agents.md](outbound-agents.md) for IVR navigation strategies using DTMF.

---

## Tool Configuration

### Voicemail Tool (`type: voicemail`)

```yaml
type: voicemail
function:
  name: end_on_voicemail
  description: >
    End the call immediately when voicemail is detected. Trigger on phrases like
    "leave a message", "at the tone", "voicemail", "not in service", etc.
messages:
  - type: request-start
    content: ""
beepDetectionEnabled: false
```

| Setting | Recommendation | Why |
|---------|---------------|-----|
| `beepDetectionEnabled: false` | Default for LLM-based detection | Beep detection via transcription is unreliable. Set `true` only with Twilio AMD. |
| `messages[0].content: ""` | Always empty for silent agents | The detection assistant should never speak. |
| `function.description` | Include trigger phrases | Reinforces detection at the tool level as a secondary signal to the LLM. |

### endCall vs Voicemail Tool

| | `endCall` tool | `voicemail` tool |
|-|---------------|-----------------|
| `endedReason` | `assistant-ended-call` | `voicemail` |
| Analytics filtering | No special category | Enables voicemail-specific analytics |
| Twilio AMD | Not available | Can enable `beepDetectionEnabled` |

**Always use the voicemail tool type** for voicemail termination — it gives you better analytics and the option for carrier-level AMD.

### Handoff Tool (for Two-Agent Relay)

```yaml
type: handoff
async: false
function:
  name: handoff_to_agent
messages:
  - type: request-start
    content: "Hello, this is [Name] calling from [Company]. Am I speaking with {{customer.name}}?"
    blocking: true
destinations:
  - type: assistant
    assistantName: "Fronter Assistant"
    description: "Conversational agent for live humans"
    contextEngineeringPlan:
      type: all
```

**Critical settings:**
- `blocking: true` on the `request-start` message ensures the greeting finishes before the fronter takes control
- `contextEngineeringPlan: { type: all }` passes full conversation context to the fronter
- The `request-start` content is what the human hears as the seamless opening line

---

## VM Detection Assistant Configuration

### Critical Settings

| Setting | Value | Why |
|---------|-------|-----|
| `firstMessage` | `""` (empty) | Never speaks first — waits silently |
| `firstMessageMode` | `assistant-waits-for-user` | Listens for recipient to speak first |
| `temperature` | `0` | Fully deterministic — no creative generation |
| `silenceTimeoutSeconds` | `15` | Catches dead air after voicemail beeps |
| `backgroundDenoisingEnabled` | `true` | Cleaner transcripts for more reliable detection |
| `voicemailMessage` | Short fallback message | Safety net if built-in detection triggers separately |

### Disable Unnecessary Processing

```yaml
analysisPlan:
  summaryPlan: { enabled: false }
  successEvaluationPlan: { enabled: false }
```

The detection assistant doesn't need post-call analysis — save the LLM call.

---

## Beep Detection: LLM vs Carrier-Level

| Method | How it works | Accuracy | Speed |
|--------|-------------|----------|-------|
| **LLM-based** (default) | Transcript pattern matching in the system prompt | High for phrases, unreliable for beeps | Depends on STT latency |
| **Twilio AMD** (`beepDetectionEnabled: true`) | Carrier-level audio analysis before LLM | Good for beep detection specifically | 2–5 seconds, before LLM |

**Recommendation:** Use LLM-based detection as your primary method (more reliable for phrase matching). Layer Twilio AMD on top only if using Twilio and you need faster beep detection.

---

## Testing Voicemail Detection

### Test Matrix

| Scenario | Expected result |
|----------|----------------|
| Carrier voicemail (AT&T, Verizon, T-Mobile) | Ends call |
| Google Voice voicemail | Ends call |
| Personal voicemail greeting ("Hey, it's [name], leave a message") | Ends call |
| Business voicemail ("You've reached [Company]...") | Ends call |
| IVR menu ("Press 1 for...") | Keeps monitoring |
| Human "Hello?" | Hands off to fronter |
| Human short utterance ("Yeah?", "Who's this?") | Hands off to fronter |
| Interrupted carrier message → human pickup | Hands off to fronter |
| Dead air / no transcription | Times out via `silenceTimeoutSeconds` |
| Fax machine tones | Times out (not transcribed) |

### Common Failures

| Failure | Root cause | Fix |
|---------|-----------|-----|
| Agent speaks to voicemail | Detection prompt missing or incomplete | Add definitive trigger phrases to prompt |
| Agent hangs up on humans saying "sorry" | "sorry" misclassified as voicemail context | Add false-positive prevention rules |
| Agent stuck on IVR forever | No timeout or exit condition | Set `silenceTimeoutSeconds` and `maxDurationSeconds` |
| Greeting plays twice (handoff + fronter firstMessage) | Fronter has its own `firstMessage` | Set fronter `firstMessage: ""` or use model-generated mode |
| Idle message ("Are you still there?") fires on voicemail edge cases | `idleTimeoutSeconds` < `silenceTimeoutSeconds` while assistant strategy is "stay silent on voicemail" | See "Idle messages collide with silence-based voicemail handling" below |

---

## Idle Messages and Voicemail Silence

### Idle messages collide with silence-based voicemail handling

When `messagePlan.idleMessages` is set with a tight `idleTimeoutSeconds` (e.g. 6s) AND the voicemail strategy is "stay silent and let platform-level `voicemailDetection` hang up the call," the two settings deadlock on every edge case where Vapi's detection has a coverage hole (full-mailbox prompts, some carrier-specific custom greetings, late-beep messages).

**What you might expect:** The static `voicemailMessage` plays and the call ends. Idle messages don't fire because there's no assistant-side silence — the platform handles everything.

**What actually happens:** When `voicemailDetection` misses, the LLM gets a turn. If the system prompt instructs it to stay silent on voicemail signals, the assistant goes silent — and `idleMessages` injects "Are you still there?" after `idleTimeoutSeconds`. Result: every voicemail-edge call ends with the idle prompt in the transcript, breaking any sim rubric that scores `idle_prompt_after_voicemail` or any post-call analysis that flags assistant utterances on voicemail. Cannot be fixed at the prompt level — even a perfect-silence prompt can't beat the platform timer.

**Concrete signature:** Every failed transcript on a voicemail-edge sim suite ends with `AI: Are you still there?` while `endedReason` is `silence-timed-out`.

**Recommendation:**
- **Preferred — two-agent relay.** Use a classifier squad member that ends the call before the main assistant ever gets a voicemail turn. The main assistant's `idleTimeoutSeconds` stays tight for human conversations.
- **Fallback — single-agent.** Set `idleTimeoutSeconds` >= `silenceTimeoutSeconds` so silence-timeout terminates the call before idle injection. This costs you idle-prompt responsiveness for genuinely-silent humans but eliminates the conflict.
- Don't try to suppress this with system-prompt rules — the idle injection happens at the platform layer, not the LLM layer.

```yaml
# Single-agent fallback (less ideal — loses tight human-side idle responsiveness)
silenceTimeoutSeconds: 15
messagePlan:
  idleMessageMaxSpokenCount: 1
  idleMessages:
    - Are you still there?
  idleTimeoutSeconds: 30  # >= silenceTimeoutSeconds → idle never fires before call ends
```

Cross-reference: see [squads.md](squads.md) for the two-agent relay pattern, and [assistants.md](assistants.md) for prompt-authoring guidance on silence rules.
