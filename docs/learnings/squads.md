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

`member.assistantDestinations` is **sugar** that the backend converts into real tools:

- Destinations with `assistantId`, `contextEngineeringPlan`, or `variableExtractionPlan` → **handoff tools**
- All other destinations → merged into a **transferCall tool** (creating one if needed)

Both mechanisms can coexist on the same member. If you use both `assistantDestinations` and inline handoff tools, you may get duplicate transfer options.

---

## Context During Handoffs

After a handoff, the new assistant does NOT get a raw copy of all prior messages. The backend applies `squadTransferMessagesApply` which may summarize, filter, or restructure the conversation history. If `handoffMessages` are provided on the destination, they **replace** the active message context entirely.

---

## Override Merge Order

```
Final = deepMerge(
  assistant,
  member.assistantOverrides,
  squad.membersOverrides,
  call.squadOverrides
)
```

Later layers win on conflicts. `variableValues` from all layers are merged separately.

**Gotcha:** Liquid template substitution replaces undefined variables with **empty strings**, not errors. If a variable isn't in the merged `variableValues`, any `{{ myVar }}` reference silently becomes `""`.
