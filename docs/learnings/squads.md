# Squad Configuration Gotchas

Non-obvious behaviors and silent defaults for Vapi squad and multi-agent setups.

---

## Name Uniqueness

**Squad member assistant names must be unique.** If two members have the same `name` field, the call fails with `"Duplicate Assistant Name"` before anything runs.

Transfer/handoff destinations reference other members by `assistantName` (the name string, not an ID). Duplicate names would make this ambiguous.

---

## tools:append vs tools in Overrides

```yaml
# tools:append ADDS to existing tools (after merge)
assistantOverrides:
  tools:append:
    - type: handoff
      function:
        name: handoff_to_agent_b
      destinations:
        - type: assistant
          assistantName: Agent B

# model.tools in overrides REPLACES (through deep merge + tool resolution)
assistantOverrides:
  model:
    tools:
      - type: function
        function:
          name: my_only_tool
```

**Recommendation:** Use `tools:append` for adding handoff tools to squad members. Use `model.tools` in overrides only when you want to replace the tool set.

---

## assistantDestinations vs Inline Tools

`member.assistantDestinations` is **shorthand** that Vapi converts into real tools:

- Destinations with `assistantId`, `contextEngineeringPlan`, or `variableExtractionPlan` → **handoff tools**
- All other destinations → merged into a **transferCall tool** (creating one if needed)

Both mechanisms can coexist on the same member. If you use both `assistantDestinations` and inline handoff tools, you may get duplicate transfer options.

---

## Context During Handoffs

After a handoff, the new assistant does NOT get a raw copy of all prior messages. Vapi may summarize, filter, or restructure the conversation history during the transfer. If `handoffMessages` are provided on the destination, they **replace** the active message context entirely.

### `contextEngineeringPlan` controls what the destination sees

| Type | Behavior | Best for |
|------|----------|----------|
| `all` (default) | Full conversation preserved, system message replaced | Continuing same conversation (e.g., VM detection → fronter) |
| `none` | Clean slate — no prior context | Starting fresh (e.g., language switch) |
| `lastNMessages` | Last N messages kept | Partial context preservation |
| `userAndAssistantMessages` | User/bot turns only (tool calls stripped) | Clean handoff without tool noise |
| `previousAssistantMessages` | Only history from before the current assistant's session — current assistant's tool-call data excluded | **PCI / compliance handoff back to a general assistant** — see [Sanitizing tool-call data across assistants](#sanitizing-tool-call-data-across-assistants-pci-pattern) below |

### The VM detection relay pattern

A common squad pattern for outbound calling: a silent detection assistant classifies the call recipient, then hands off to a conversational "fronter" assistant.

The handoff tool's `request-start` message carries the **spoken opening line** with `blocking: true`. The human hears this as a seamless greeting from what they perceive as the caller, while the fronter assistant takes over behind the scenes.

```yaml
# On the detection assistant's handoff tool
messages:
  - type: request-start
    content: "Hello, this is [Name] from [Company]. Am I speaking with {{customer.name}}?"
    blocking: true
destinations:
  - type: assistant
    assistantName: "Fronter Assistant"
    contextEngineeringPlan:
      type: all
```

**Critical:** `blocking: true` ensures the greeting finishes before the fronter takes control. Without it, the fronter could interrupt mid-greeting.

See [voicemail-detection.md](voicemail-detection.md) for the full two-agent relay architecture.

### Request-start transcript attribution and destination prompt context

The handoff's `request-start` message is delivered via the SOURCE assistant's TTS pipeline. In the canonical transcript (`messagesOpenAIFormatted`), the spoken opener appears as a `role: assistant` content turn attributed to the source — not the destination. The destination assistant's runtime `messages` array, on the other hand, **does not** contain the request-start. The destination is woken up with no record of the opener having been delivered.

This creates two distinct problems for the destination assistant's first generated turn:

1. **The destination can't "see" that the opener was delivered.** Its system prompt may say "the handoff tool just delivered the opener" but the conversation history contradicts that (no prior assistant turn). Under that contradiction, the model defaults to its strong prior — typically "I'm an assistant on an outbound call, my first turn should be a greeting" — and re-greets, which the customer hears as a redundant intro right after the request-start opener.

2. **Practitioner-pattern violation amplifies the re-greet.** If the destination's system prompt has the opener QUOTED VERBATIM inside a "do NOT say this" instruction, the model reads it as a high-activation token block in active context. With the conversation-history contradiction above, the model falls back on the most-activated tokens and generates the opener — the exact text the prompt told it not to say. Same priming mechanism that bites any prompt that quotes forbidden output text in a "never say this" block.

**Recommendation** for any destination assistant whose role is to continue a handed-off conversation:

- **Never quote forbidden output text verbatim in the prompt.** Describe the constraint structurally instead of by example. For instance, encode the rule as: *"The handoff tool just delivered the opener (a one-paragraph greeting introducing your role and the topic). Your first turn MUST be a continuation. Forbidden first-turn shapes: any greeting (Hey/Hi/Hello + name), any name introduction (this is X / I'm X), any company mention combined with self-introduction, any 'reaching out about' phrase."*
- **Pair with the `firstMessage` patterns from above.** Set `firstMessage: ""` and `firstMessageMode: assistant-speaks-first-with-model-generated-message` (see [`firstMessage` replays on every handoff re-entry, not just call start](#firstmessage-replays-on-every-handoff-re-entry-not-just-call-start)). The model then synthesizes a contextual continuation rather than replaying any intro.

For sim suites grading the destination's first-turn behavior, see [simulations.md → Squad handoff `request-start` is attributed to the SOURCE assistant in the transcript](simulations.md#squad-handoff-request-start-is-attributed-to-the-source-assistant-in-the-transcript) and the surrounding LLM-as-Judge artifact section — the same architectural fact has consequences for both prompt design AND rubric authoring.

---

## Passing data between assistants

Cross-reference: [docs.vapi.ai/squads/passing-data-between-assistants](https://docs.vapi.ai/squads/passing-data-between-assistants). The trust-tier framing came out of progressive caller-ID auth work on a customer rollout.

When a squad hands off mid-call, three approaches exist for getting data from one assistant to the next. They differ on trust level, latency, and determinism.

| Approach | Mechanism | Trust | Latency |
|---|---|---|---|
| **Handoff arguments** | `function.parameters` on the handoff tool. The LLM fills the arg inline with the handoff call. | LLM-derived. Use for sentiment / intent classifications. **NOT a security boundary.** | Free (already in the handoff turn) |
| **`variableExtractionPlan.schema`** | A dedicated LLM extraction call against the conversation transcript at handoff time. | LLM-derived. **NOT a security boundary.** | Adds a full LLM round-trip |
| **Liquid variables in the destination prompt** | The variable bag is shared across squad members for the call's lifetime. The next assistant references `{{ customer.number }}`, prior alias values, etc. directly in its prompt or its tools' static `parameters`. | **Server-trusted IF the underlying values are call-level (Tier 1).** See [assistants.md → Liquid Variable Bag and Trust Tiers](assistants.md#liquid-variable-bag-and-trust-tiers). | Sub-millisecond, deterministic |

**Crucial property:** call-level Liquid variables (`{{ customer.number }}`, `{{ phoneNumber.number }}`, `{{ call.id }}`, `{{ now }}`) persist across handoffs because they live on the call object, not the active assistant. The next assistant references the same trusted variable in its own tools' static `parameters` — no handoff-side configuration needed.

### Static config per destination: `destination.assistantOverrides.variableValues`

Defined on the handoff tool's destination, merged into the variable bag at handoff time, bypasses the LLM entirely. Use for per-destination static config the next assistant should know about: `{ "tier": "premium" }`, `{ "slaWindowSeconds": 30 }`.

**Known limitation (logged in `improvements.md`):** Liquid templates inside `destination.assistantOverrides.variableValues` are NOT currently resolved at handoff time. If you write `"verifiedCaller": "{{ customer.number }}"`, the bag holds the literal string `"{{ customer.number }}"` instead of the resolved phone number. Workaround: rely on the squad-level variable bag persistence — call-level variables are already shared across squad members for the call's lifetime, so the next assistant can reference `{{ customer.number }}` directly. Use `assistantOverrides.variableValues` only for per-destination *literal* values.

### Sanitizing tool-call data across assistants (PCI pattern)

When a privileged sub-assistant collects sensitive data via tool calls (PCI card capture, SSN lookup), control needs to hand back to a general-purpose assistant without that general assistant ever seeing those tool responses. `contextEngineeringPlan.type: previousAssistantMessages` is the only Vapi primitive that scrubs current-assistant tool-call data from the next assistant's view — it's a handoff-time redaction, not an in-assistant one.

```yaml
# On the privileged assistant's handoff tool, returning to a general assistant
destinations:
  - type: assistant
    assistantName: General Agent
    contextEngineeringPlan:
      type: previousAssistantMessages
```

Within a single assistant there is no equivalent. `request-complete` is a speech lever, `variableExtractionPlan` aliases give determinism but not invisibility, and tool responses are always in the next-completion conversation history. If the model must not see a value, your tool server must not place it in the response body in the first place. See [tools.md → Every tool result is in conversation history](tools.md#every-tool-result-is-in-conversation-history).

### Enabling PCI for every squad member

Squads do not have a first-class `squad.compliancePlan` field. To enable PCI mode for all members, set it through `membersOverrides`, which is applied to every resolved assistant before the call-level compliance plan is computed.

```yaml
membersOverrides:
  compliancePlan:
    pciEnabled: true
```

For a one-off call using an existing `squadId`, the same shape can be passed as `squadOverrides.compliancePlan.pciEnabled`. Org-level `org.compliancePlan.pciEnabled` also applies globally. The squad builder UI currently exposes model, voice, and transcriber overrides, but not a PCI toggle, so use API/gitops JSON for squad-level PCI.

---

## Override Merge Order

The final assistant configuration is built by merging these layers in order:

1. Base assistant
2. `member.assistantOverrides`
3. `squad.membersOverrides`
4. `call.squadOverrides`

Later layers win on conflicts. `variableValues` from all layers are merged separately.

**Gotcha:** Liquid template substitution replaces undefined variables with **empty strings**, not errors. If a variable isn't in the merged `variableValues`, any `{{ myVar }}` reference silently becomes `""`.

---

## toolIds in assistantOverrides require UUIDs

`assistantOverrides.model.toolIds` in squad members must use **Vapi platform UUIDs**, not local filenames. The gitops engine resolves filenames to UUIDs for base assistant `model.toolIds`, but it does **not** resolve them inside squad `assistantOverrides`. If you use a local filename, the push will fail with `each value in toolIds must be a UUID`.

**Workaround:** Look up the tool's UUID from `.vapi-state.<env>.json` and use it directly.

```yaml
# WRONG — filename, will fail in assistantOverrides
assistantOverrides:
  model:
    toolIds:
      - my-tool-name

# CORRECT — platform UUID
assistantOverrides:
  model:
    toolIds:
      - a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

## Inline `model.messages` in `assistantOverrides` silently shadows the assistant `.md`

**What you might expect:** `assistantOverrides` is a deep merge — partial fields override partial fields, and the assistant's own `.md` system prompt is preserved if you don't touch `model.messages`.

**What actually happens:** If you add `model.messages` (or any `model.*` field that includes the system message) inside a squad member's `assistantOverrides`, that array fully replaces the assistant's compiled prompt at runtime. The `.md` body becomes dead code for that member — silently. There is no warning at push time, no diff in the dashboard that calls it out, and the only symptom is the assistant behaving differently in the squad than it does standalone.

This is especially insidious when the override is large (e.g. a multi-thousand-character prompt pasted inline), because the inline text drifts away from the `.md` source over time and no longer matches.

**Recommendation:**

- Treat the assistant `.md` file as the single source of truth for the system prompt.
- Use `assistantOverrides` for non-prompt knobs (`tools:append`, `temperature`, `firstMessage`, `firstMessageMode`, `voice`, `transcriber`).
- If you genuinely need a different prompt for a squad context, create a second assistant `.md` and reference it as a separate squad member instead of inlining the prompt.

```yaml
# WRONG — this silently replaces the assistant's .md prompt
members:
  - assistantId: faq-specialist-a1b2c3d4
    assistantOverrides:
      model:
        provider: openai
        model: gpt-4.1
        messages:
          - role: system
            content: |
              You are an FAQ specialist. (...8000 chars of prompt drifting from the .md...)

# CORRECT — keep the .md as the only prompt source
members:
  - assistantId: faq-specialist-a1b2c3d4
    assistantOverrides:
      model:
        temperature: 0.3   # non-prompt overrides only
      tools:append:
        - type: handoff
          # ...
```

---

## `firstMessage` replays on every handoff re-entry, not just call start

**What you might expect:** `firstMessage` is the assistant's opening line at the start of a call.

**What actually happens:** With `firstMessageMode` at its default (`assistant-speaks-first`), `firstMessage` fires **every time control hands back to that assistant** — not just on the initial call. In a squad with cyclical routing (e.g. Primary → FAQ → Primary, or Closeout → Primary on objection), the customer hears the intro line repeated on each re-entry, which sounds like a hard reset of the conversation.

**Recommendation:** For any squad member that can be re-entered after a handoff (i.e. any member except a strictly terminal one like Closeout), set:

```yaml
firstMessage: ""
firstMessageMode: assistant-speaks-first-with-model-generated-message
```

The LLM then synthesizes a contextual continuation line on re-entry rather than replaying the intro. Pair this with a "CALL-START vs HANDOFF-RE-ENTRY" block at the top of the system prompt so the model knows which behavior to use:

```
# RE-ENTRY PROTOCOL

If this is the first turn of the call (no prior conversation in your context),
greet the caller and begin the workflow.

If you are receiving control via a handoff (prior conversation present), do
NOT re-greet. Pick up from where the previous specialist left off.
```

The terminal member (Closeout, etc.) is the only place a static `firstMessage` is safe — and only because nothing should hand back to it.

---

## Two silence handlers fire at once when both are configured

**What you might expect:** `messagePlan.idleMessages` (per-assistant) and `customer.speech.timeout` hooks (per-assistant or via `membersOverrides.hooks`) are alternative ways to handle silence — pick one and the other is dormant.

**What actually happens:** Both fire independently on the same silence event. If a member has `idleMessages` AND the squad has `membersOverrides.hooks` with a `customer.speech.timeout` action, the customer hears the idle message **and** the hook's spoken action back-to-back, often within the same beat. It feels like the agent is interrupting itself.

**Recommendation:** Pick one mechanism per squad. Squad-level `customer.speech.timeout` hooks are usually preferable because:

- They apply uniformly to every member without per-assistant duplication.
- They support escalation patterns (`triggerMaxCount`, `triggerResetMode: onUserSpeech`) that idle messages don't.
- They can chain `say` + `endCall` for graceful timeout-based hangup.

If you choose hooks, leave `messagePlan` unset on each member (or set `idleMessages: []`). If you choose idle messages, omit the silence hook from `membersOverrides`. See [call-duration.md](call-duration.md) for the timeout-vs-hook distinction.

---

## FAQ agent consolidation pattern

When a squad has multiple specialist agents that each carry one knowledge base tool, the LLM must correctly classify and route the question before it even reaches a KB. If the routing is wrong, the KB returns "I don't have enough information" — not because the knowledge doesn't exist, but because the wrong KB was queried.

**Fix:** Consolidate specialist agents into a single FAQ agent with access to all KB tools. The FAQ agent's LLM picks the right tool based on improved tool descriptions with explicit routing boundaries and "Do NOT use for..." cross-references. This eliminates the routing classification step from the handoff layer and moves it to the tool selection layer, where descriptions give the LLM more direct guidance.
