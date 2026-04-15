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

## FAQ agent consolidation pattern

When a squad has multiple specialist agents that each carry one knowledge base tool, the LLM must correctly classify and route the question before it even reaches a KB. If the routing is wrong, the KB returns "I don't have enough information" — not because the knowledge doesn't exist, but because the wrong KB was queried.

**Fix:** Consolidate specialist agents into a single FAQ agent with access to all KB tools. The FAQ agent's LLM picks the right tool based on improved tool descriptions with explicit routing boundaries and "Do NOT use for..." cross-references. This eliminates the routing classification step from the handoff layer and moves it to the tool selection layer, where descriptions give the LLM more direct guidance.
