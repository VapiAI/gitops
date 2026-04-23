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
