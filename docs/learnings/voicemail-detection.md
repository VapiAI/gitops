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
