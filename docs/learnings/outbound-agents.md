# Outbound Agent Design

How to build outbound AI voice agents that handle the unique challenges of calling people who didn't ask to be called.

---

## Why Outbound Is Different

Inbound agents talk to people who chose to call. Outbound agents face a fundamentally different set of problems:

| Challenge | Why it matters |
|-----------|---------------|
| **Unknown destination** | May reach human, voicemail, IVR, fax, or nothing |
| **Recipient skepticism** | They didn't initiate contact — may assume spam |
| **First 3–5 seconds are critical** | Determines whether they hang up or engage |
| **Varied phone systems** | Different carriers, business PBXs, VoIP providers, Google Voice |

---

## The Three Scenarios

Every outbound call lands in one of these:

| Scenario | Detection method | Required action |
|----------|-----------------|----------------|
| **Human** | Natural greeting, conversational speech | Proceed with task |
| **Voicemail** | Carrier/personal greeting with "leave a message" signals | End call immediately with voicemail tool |
| **IVR** | "Press 1 for..." menu options | Navigate to reach a human |

For detailed voicemail/human detection logic, see [voicemail-detection.md](voicemail-detection.md).

---

## IVR Navigation

### Phase 1: Aggressive — Try Shortcuts First

Most IVR systems have hidden shortcuts. Try these before listening to the full menu:

1. **Press 0 three times** (DTMF tool) — many systems route 0 to an operator
2. **Say "representative"** 2–3 times
3. **Say "operator"** 2–3 times

During this phase: don't introduce yourself, don't say anything else, don't press other buttons.

If transferred to hold music, wait silently for a human.

### Phase 2: Structured — Navigate the Menu

If shortcuts fail, listen to the full menu and select strategically:

| Option type | Action |
|-------------|--------|
| "Speak to someone" / "Representative" / "Operator" | Select this |
| "Front desk" / "Store" / "Host" / "Manager" | Good second choice |
| "Orders" / "Billing" | Often has humans |
| "Store hours" / "Directions" | Avoid — usually recordings |
| "For English, press 1" | Press 1 first, then navigate |

### When to Give Up

End the call when:
- You've tried both phases and the IVR keeps looping
- You're redirected to "visit our website" or "call another number"
- The IVR ends in voicemail

Don't give up after just one attempt. Make a good-faith effort with multiple paths.

### DTMF Tool Configuration

```yaml
type: dtmf
```

The built-in DTMF tool lets the agent press phone keypad buttons. No additional configuration needed.

---

## Opening Statement Design

The opening line determines whether the recipient hangs up. Optimize ruthlessly.

### What Works

```
"Hi, are you open right now?"
"Hi, I'm calling about your recent order."
"Hi, this is a quick call to confirm your appointment tomorrow."
```

**Why:** Under 5 seconds, asks a simple question, gets to the point, doesn't trigger "sales call" defenses.

### What Doesn't Work

```
"Hello, my name is Alex and I'm an automated assistant calling
on behalf of Acme Corp regarding your account. How are you today?"
```

**Why:** Too long, robotic framing, "How are you today" is an obvious sales opener that triggers immediate hang-up.

### Rules

- **Get to the point in the first sentence** — no preamble
- **Keep it under 5 seconds** of speech
- **Ask a simple question** — gives them something to respond to
- **Don't volunteer your identity** — but answer honestly if asked

---

## Identity Handling

Don't reveal that you're an AI in the opening. But never lie when asked directly.

| They say | You respond |
|----------|------------|
| "Who is this?" | "This is an automated system from [Company] calling to [purpose]." |
| "Are you a robot?" | "Yes, I'm an automated assistant calling on behalf of [Company]." |
| "Are you a real person?" | "I'm an automated assistant. I'm calling to [purpose]." |
| Unrelated questions | "I can only help with [specific task]. For other questions, please contact [Company] support." |

---

## Conversation Flow Design

### The Five Golden Rules

1. **Be direct** — get to the point in the first sentence
2. **Be brief** — short sentences, simple words
3. **Don't rush** — wait for responses after each statement
4. **Stay in scope** — only do what you're designed to do
5. **End gracefully** — always thank them before hanging up

### Step-by-Step Flow Template

```markdown
## Step 1: Opening
- Deliver opening line
- Wait for response

## Step 2: Handle Response
- Clear answer → acknowledge and continue
- Unclear → ask for clarification (max 2 times)
- No response → repeat once, then close

## Step 3: Provide Context (if needed)
- Explain why you're calling (1–2 sentences max)
- Wait for response

## Step 4: Listen & Acknowledge
- If they share info → acknowledge empathetically
- Do NOT prompt for additional information unprompted
- Do NOT rush to the next step

## Step 5: Close
- Summarize outcome (if applicable)
- Thank them
- End call gracefully
```

---

## Pacing and Interruption

LLMs tend to rush through outbound scripts. Counter this explicitly in your prompt:

```markdown
# Pacing Guidelines

- DO NOT rush through the conversation
- Wait for the user to respond after each statement
- Use natural pauses: <break time='0.3s'/>
- If they're speaking, do not interrupt
- Give them time to process — they weren't expecting this call
```

### Model Parameters for Outbound

```yaml
model:
  provider: openai
  model: gpt-4.1
  temperature: 0.1
  maxTokens: 250
```

- **Low temperature** (0.1) — consistent, predictable responses
- **Low maxTokens** (250) — forces brief responses, prevents monologues

---

## Error Handling

| Situation | Response |
|-----------|----------|
| No response after opening | Repeat question once, then thank and end call |
| Unclear answer after 2 attempts | Acknowledge and proceed to closing |
| Complaints | Acknowledge empathetically, do not offer solutions, direct to support |
| Hostility | Thank them for their time and end call gracefully |
| "Take me off your list" | Acknowledge, apologize, end call. Flag for suppression list. |

---

## Required Tools for Outbound

Every outbound agent needs at minimum:

```yaml
# 1. Voicemail detection (ends call with 'voicemail' endedReason)
type: voicemail
function:
  name: end_call_on_voicemail
  description: End the call immediately when voicemail is detected.
beepDetectionEnabled: false

# 2. DTMF (for IVR navigation)
type: dtmf

# 3. End call (for graceful termination)
type: endCall
function:
  name: end_call
  description: End the call after completing the task or when unable to proceed.
```

---

## Prompt Structure for Outbound

Recommended section order for outbound agent system prompts:

```markdown
# Identity
[Who the agent is, what company, what purpose]

# Identity Lock
[Fixed identity, scope limits, jailbreak prevention]

# Call Type Awareness
[How to detect voicemail/IVR/human — brief version]

# Voicemail Detection
[Trigger phrases and action — use voicemail tool]

# IVR Navigation
[Phase 1 aggressive + Phase 2 structured]

# Task & Goals
[Step-by-step conversation flow]

# Response Guidelines
[Tone, pacing, brevity rules]

# Error Handling
[What to do when things go wrong]

# Examples
[Concrete conversation examples with tool calls]

# Tools Available
[List of tools and when to use each]
```

---

## Metrics and Testing

### Key Metrics

| Metric | Target | Notes |
|--------|--------|-------|
| Connection rate | >60% | Calls that reach human or voicemail |
| Voicemail detection accuracy | >95% | Test against carrier/personal/business VM |
| Task completion rate | >80% | Of calls that reach humans |
| Average call duration | <60s | For simple tasks |
| Hang-up rate (first 5s) | <20% | Opening effectiveness |

### Test Matrix

| Scenario | What to verify |
|----------|---------------|
| Human — cooperative | Completes task successfully |
| Human — confused ("Who is this?") | Handles identity questions gracefully |
| Human — hostile | Exits gracefully without escalating |
| Human — doesn't answer question | Clarifies appropriately |
| Voicemail — carrier greeting | Detects and ends call |
| Voicemail — personal greeting | Detects and ends call |
| Voicemail — Google Voice | Detects and ends call |
| Voicemail — business voicemail | Detects and ends call |
| IVR — simple menu | Navigates to human |
| IVR — complex menu | Makes good-faith attempt |
| IVR — no human option | Ends call appropriately |
| IVR — Spanish option first | Handles language selection |
| Silence | Handles via timeout |
| Background noise | Functions with kitchen/office noise |
| Interruption | Handles being interrupted mid-sentence |
| Off-topic question | Stays in scope |
| Jailbreak attempt | Maintains identity lock |
