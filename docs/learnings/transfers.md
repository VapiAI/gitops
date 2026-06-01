# Transfer & Handoff Troubleshooting

A diagnostic guide for when `transferCall` or `handoff` tools don't work as expected. Walk through these steps in order to identify and fix the issue.

---

## Step 1: Confirm whether the tool call happened at all

### Symptom

Caller hears something like "Please hold while I transfer you" and then nothing happens — silence, call times out, or the original assistant continues talking.

### What it usually means

The model produced a text-only response instead of a tool call. This is common when the tool description is vague or the prompt doesn't explicitly require the tool call.

### How to fix

Make tool execution rules explicit in the system prompt. Put them at the **end** of the prompt so they're freshest in the model's context window.

**Recommended prompt pattern** — add this at the end of your system prompt:

```
CRITICAL TOOL-CALL RULES — these override any ambiguity above:

1. Whenever you decide to transfer, you MUST invoke the transferCall
   function in that same response.
2. Your spoken acknowledgment and the transferCall tool call happen
   in the SAME response turn.
3. If you already said "I'll connect you now" but the call is still
   active, immediately invoke transferCall again without saying
   anything else.
```

---

## Step 2: Fix tool descriptions that make the model reluctant

### Symptom

The assistant "knows" it should transfer, but it frequently doesn't.

### What it usually means

Some tool configurations end up with language like "DO NOT call this function unless instructed" in the tool description the LLM sees. This biases the model toward not calling it.

### How to fix

- **Always set an explicit `function.description`** on your transferCall/handoff tools. Without a custom description, some setups inject overly cautious guardrails into the tool definition.
- **Make destination `description` fields specific and use-case oriented.** The LLM uses these descriptions to select the right destination — they're effectively part of your routing policy.

```yaml
destinations:
  - type: number
    number: "+15551234567"
    description: "Transfer to the billing department for payment and invoice questions"
    message: "Let me connect you with our billing team."
```

---

## Step 3: Use the right mechanism (transferCall vs handoff)

### Symptom

You're trying to transfer to another assistant in a squad, but it behaves like it's dialing a phone number, hallucinates a destination, or intermittently stalls.

### What it usually means

`transferCall` is a **telephony-forwarding** primitive — it dials phone numbers and SIP URIs. For transferring between assistants in a squad, use the `handoff` tool type instead.

### When to use each

| Mechanism | Use when |
|-----------|----------|
| `transferCall` | Transferring to an external phone number, SIP URI, or PBX |
| `handoff` | Transferring between assistants within a squad |
| `assistantDestinations` on squad members | Shorthand for handoff — Vapi converts these to handoff tools automatically |

Using `transferCall` for assistant-to-assistant routing can cause the original assistant to continue with an error message when the transfer doesn't work as expected.

---

## Step 4: Distinguish "platform executed transfer" from "telephony transfer succeeded"

### Symptom

The call's `endedReason` says the transfer happened (e.g., `assistant-forwarded-call`), but the destination never rang.

### What it usually means

`assistant-forwarded-call` means "Vapi initiated the transfer," not "the downstream provider successfully completed it." The telephony leg can still fail.

### Common telephony failure modes

**SIP REFER not supported by provider:**
Some SIP trunks/providers don't support the REFER method. The call ends during transfer with no ring at the destination. Fix: remove explicit `sipVerb: "refer"` from your `transferPlan` and let Vapi use the default transfer mechanism.

**Provider-specific auth issues:**
Some providers (especially with SIP REFER) reject the transfer due to authentication header issues. The call looks "forwarded" on the Vapi side but drops at the provider level. Check your provider's transfer compatibility docs.

### How to verify

Check the call's `endedReason` and provider-level call logs:
- `assistant-forwarded-call` = Vapi sent the transfer command
- Actual ring/answer = check your telephony provider's logs/CDRs

---

## Step 5: Watch for transient assistant foot-guns

If you're using transient assistants (created per-call via API), two extra issues arise:

### Tool descriptions drift between calls

If your tool's `description` isn't explicitly set, the auto-generated description can vary slightly between calls. This inconsistency can reintroduce LLM reluctance to call the tool.

**Fix:** Treat `function.description` as required configuration. Set it explicitly and keep it stable across calls.

### One-shot transfer flows are fragile

Transient assistants often appear in flows where you want immediate transfer behavior. Any prompt ambiguity increases the chance the model speaks first and stalls instead of calling the tool.

**Fix:** Put transfer rules at the end of the system prompt. Prefer a single atomic response that both acknowledges and invokes the tool.

---

## Quick Triage Checklist

Use this checklist when debugging transfer issues:

1. **Did a tool call appear?** Check the call transcript/messages. If the assistant only said "I'll transfer you" without a tool call, it's a prompt issue (Step 1).
2. **Did the tool call error?** Check for validation or configuration errors in the tool call result. If so, it's a config issue (Step 2).
3. **Is this a telephony failure?** Check if `endedReason` shows `assistant-forwarded-call` but the destination never rang. If so, it's a provider/SIP issue (Step 4).
4. **Are you using the right tool type?** If transferring between squad assistants, use `handoff` not `transferCall` (Step 3).
5. **Are you seeing intermittent "trouble accessing the system" messages?** This is often the LLM generating error text after a failed tool result — check the tool call result for errors.
