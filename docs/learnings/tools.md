# Tool Configuration Gotchas

Non-obvious behaviors and silent defaults for Vapi tool types.

---

## apiRequest Tools

### `body` is the single source of truth for the LLM schema

**What you might expect:** `function.parameters` and `body` are two independent schemas — one for the LLM, one for the HTTP request.

**What actually happens:** Vapi **overwrites** `function.parameters` with a copy of `body` when the tool is processed. Whatever you define in `body.properties` becomes the tool schema the LLM sees. Any `function.parameters` you set on an apiRequest tool is **silently ignored**.

**Recommendation:** Only define your schema in `body`. Do not set `function.parameters` on apiRequest tools.

### Static `parameters` override LLM-produced body fields

**What you might expect:** Static `parameters` (key-value pairs) only fill in defaults when the LLM omits keys.

**What actually happens:** The final HTTP body is `{ ...bodyFromLLM, ...staticParameters }`. Static parameters **win** on key collisions — they override whatever the LLM produced.

**Recommendation:** Use static `parameters` for secrets, API keys, or fixed fields that should never come from the LLM. Be aware they will overwrite matching keys from LLM output.

### Default HTTP method is POST

If you omit `method`, it defaults to `POST` — not `GET`.

### API response must be JSON

On a successful HTTP response (2xx), Vapi expects a JSON body. If your API returns non-JSON (plain text, HTML, XML), the tool call will error.

### `function.strict` is always cleared

Vapi removes `strict` from apiRequest tools when they are processed. If you need strict schema enforcement from the LLM provider, use a `function` type tool instead.

### `async` has no effect

Vapi ignores `async` on apiRequest tools. They always execute synchronously (HTTP call → wait for response → return to LLM).

### Credential fallback behavior

If `credentialId` is set on the tool, that specific credential is used. If omitted, Vapi picks one from the call's available credentials automatically. If you have multiple webhook credentials, always set `credentialId` explicitly to avoid ambiguity.

---

## function Tools

### Missing `server` is not an error

**What you might expect:** A function tool without `server.url` fails at runtime.

**What actually happens:** Vapi falls back through a hierarchy: tool `server.url` → assistant `server.url` → phone number `server.url` → org `server.url`. Omitting `server` on the tool is valid if the assistant or org has a server URL configured.

**Recommendation:** Set `server.url` on the tool for clarity, or document which level provides the webhook URL.

### `async: true` changes execution flow significantly

- `async: false` (default): The LLM waits for the tool result before continuing. The user hears `request-start`, `request-response-delayed` messages while waiting.
- `async: true`: The tool call is queued. The LLM continues without waiting. `request-start`, `request-response-delayed`, and `request-failed` message types are **skipped** for async tools.

**Recommendation:** Only use `async: true` when the tool result doesn't need to influence the conversation flow.

### `strict: true` requires a specific schema shape

When `strict: true` is set on a function tool:
- Every `object` node must have `additionalProperties: false`
- Every property must be listed in `required`
- Strict mode must be enabled for your organization

If the schema doesn't meet these requirements, `strict` may be silently disabled for that tool.

---

## transferCall Tools

### Forwarding numbers from the assistant are auto-injected

**What you might expect:** Only the `destinations` array on the tool matters.

**What actually happens:** If the assistant has `forwardingPhoneNumber` or `forwardingPhoneNumbers` set, those numbers are **appended** to the tool's destinations list. This changes the LLM-visible enum of transfer options.

**Recommendation:** Audit both the tool's `destinations` and the assistant's forwarding number fields.

### Destinations with no name are silently dropped from the LLM enum

If a destination has no resolvable name (no `number`, `sipUri`, `assistantName`, or `stepName`), it is skipped when building the LLM-visible parameter enum. The destination still exists but the LLM won't know about it.

### `transferPlan.mode` aliases (use canonical names)

Old mode strings are silently rewritten:
- `warm-transfer-with-summary` → `warm-transfer-say-summary`
- `warm-transfer-with-message` → `warm-transfer-say-message`
- `warm-transfer-with-twiml` → `warm-transfer-twiml`

Use the canonical names to avoid confusion.

### Variable substitution is NOT applied to `summaryPlan`

Liquid/Mustache templates work in `sipVerb`, `message`, and `twiml` fields, but intentionally **do not** run on `summaryPlan` content.

### Missing `function.description` can make the LLM reluctant to transfer

If you don't set an explicit `function.description` on a transferCall tool, the auto-generated description may include overly cautious language that biases the LLM toward not calling it. Always set `function.description` explicitly.

### `sipVerb: "refer"` can silently fail with some providers

If your SIP trunk or telephony provider doesn't support the REFER method, transfers will appear to initiate on the Vapi side (`endedReason: assistant-forwarded-call`) but the destination never rings. If you're seeing this, remove explicit `sipVerb: "refer"` from your `transferPlan` and let Vapi use the default mechanism.

**See also:** [transfers.md](transfers.md) for a full diagnostic guide on transfer issues.

---

## endCall Tools

### Legacy `endCallFunctionEnabled` still creates a tool

If `endCallFunctionEnabled: true` is set on the assistant and no explicit `endCall` tool exists in `model.tools`, one is synthesized automatically. The `endCallMessage` from the assistant becomes the default `request-start` message.

**Recommendation:** Use an explicit `endCall` tool in `model.tools` for full control. If you use `endCallFunctionEnabled`, know that it auto-generates a tool.

### `endedReason` reflects `assistant-ended-call`

When the LLM invokes an endCall tool, the call's `endedReason` is set to `assistant-ended-call` — not `customer-ended-call` or a generic hangup reason. Use this in post-call analysis and structured output evaluations.

---

## handoff Tools

### Default `async` is `false` (unlike many other tools)

Handoff tools explicitly default `async` to `false`. Set `async: true` explicitly if you want async/webhook-style behavior.

### Auto-generated function names

If you don't set `function.name`:
- Single destination: `handoff_to_<normalized_assistant_name>`
- Multiple destinations: `handoff_to_group_<index>`

**Recommendation:** Set `function.name` explicitly if your system prompt references the tool by name.

### Destination resolution is fuzzy

Vapi tries multiple matching strategies for the model's destination argument:
1. Match by UUID (`assistantId`, `squadId`)
2. Match by name (`assistantName`, squad `name`)
3. Fall back to first destination if argument is `"dynamic"` or missing
4. Attempt to parse raw strings as phone numbers

**Recommendation:** Use explicit destination identifiers. Don't rely on fallback logic for compliance-sensitive routing.

---

## code Tools

### Execution timeout is capped at 30 seconds

Even if you set `timeoutSeconds: 60`, the effective timeout is capped at **30 seconds**.

### Code must be valid top-level async JavaScript

Code runs in a managed sandbox as Node.js. The code receives `args` (tool arguments) and `env` (environment variables) as globals. Return values are captured from the resolved promise.

### Static validation checks `args.*` and `env.*` references

When saving a code tool, Vapi parses your code and validates that every `args.foo` reference has a matching property in `function.parameters.properties`, and every `env.BAR` reference has a matching key in `environmentVariables`. Mismatches are rejected.

### `function.strict` is cleared (like apiRequest)

Strict mode is not supported on code tools.

---

## Tool Messages

### `blocking: true` on `request-start` delays tool execution

When `blocking: true`, the assistant speaks the full `request-start` message (waits for TTS to finish) **before** the tool call begins. This adds latency but ensures the user hears the announcement.

When `blocking: false` (default), the tool call fires immediately while TTS speaks in parallel.

### Message conditions use AND logic

If a message has `conditions`, **all** conditions must match the tool call arguments. Messages without conditions are used as defaults when no conditioned message matches.

### `request-complete` requires a truthy result

The `request-complete` message only fires when the tool returns a non-empty result. If the tool returns an error or empty result, use `request-failed` instead.

### `request-complete` with `role: system` becomes an LLM hint

Instead of speaking to the user, a `role: system` complete message is injected into the LLM context as a system message — useful for steering the model's next response.

### Typos in message `type` silently degrade to `request-failed`

An unrecognized message type is coerced to `request-failed` with default error copy. You won't get a validation error.

### `request-response-delayed` has a 2.5s cooldown

After one delayed message plays, another won't play for at least 2.5 seconds — even if multiple timing thresholds are crossed. Missing `timingMilliseconds` defaults to the 0ms bucket.

### Dead air during KB/API tool calls

If a tool has no `request-start` content (or empty content), the caller hears silence while the tool executes. For knowledge base tools and API requests that take 2–5 seconds, this feels like dead air.

**Fix with two layers:**

1. **`request-start`** with `blocking: false` — speaks a filler line ("Good question — let me look that up") in parallel with the tool call starting.
2. **`request-response-delayed`** at 4000ms — safety net if the tool takes longer than expected.

```yaml
messages:
  - type: request-start
    content: "Good question — let me look that up."
    blocking: false
  - type: request-response-delayed
    content: "Still looking that up for you."
    timingMilliseconds: 4000
```

Optionally add prompt-level instructions ("say a brief acknowledgment before calling the tool") as a belt-and-suspenders approach — the prompt handles cases where the LLM speaks before calling the tool, while the tool message handles cases where the LLM calls the tool silently.

---

## voicemail Tools

### Use voicemail type, not endCall, for voicemail termination

The `voicemail` tool type sets `endedReason` to `voicemail` (not `assistant-ended-call`), which enables voicemail-specific analytics filtering and retry logic.

```yaml
type: voicemail
function:
  name: end_call_on_voicemail
  description: End the call immediately when voicemail is detected.
messages:
  - type: request-start
    content: ""
beepDetectionEnabled: false
```

### `beepDetectionEnabled` is carrier-level, not LLM-level

Setting `beepDetectionEnabled: true` enables **Twilio AMD** (Answering Machine Detection) at the telephony layer. This detects voicemail in 2–5 seconds using audio analysis, before the LLM even processes the transcript.

**Only works with Twilio.** Other telephony providers ignore this setting. For non-Twilio setups, rely on LLM-based detection via the system prompt.

### `function.description` reinforces detection as a secondary signal

The LLM sees the tool's `function.description` alongside the system prompt. Including voicemail trigger phrases in the description gives the LLM a second signal for detection, but the system prompt is the primary detection engine.

### Silent tool messages for detection agents

For voicemail detection assistants that should never speak, set `messages[0].content: ""` (empty string). The tool still fires, but no audio is produced.

---

## dtmf Tools

### DTMF requires no configuration

The `dtmf` tool type is built-in and requires no function definition, parameters, or server URL:

```yaml
type: dtmf
```

The agent can press phone keypad buttons by calling this tool with the digit(s) to send. Used primarily for IVR navigation in outbound calling scenarios.

### DTMF is telephony-only

DTMF tones are a telephony concept. This tool has no effect on WebSocket or web-based calls.

---

## Tool strict Mode Summary

| Tool type | `strict` behavior |
|-----------|-------------------|
| `function` | **Preserved** — passed to LLM provider if strict mode is enabled for your org |
| `apiRequest` | **Removed** when the tool is processed |
| `code` | **Removed** when the tool is processed |
| `transferCall` | **Removed** when the tool is processed |
| `endCall` | **Removed** when the tool is processed |
| `handoff` | **Removed** when the tool is processed |

Only `function` tools support `strict` mode.
