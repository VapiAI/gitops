# Writing system prompts

The markdown body of an assistant `.md` file is the system prompt — the core instructions that define how the AI behaves on a call. This is the most important part to get right.

**Before drafting or changing prompts:** work through the [Vapi Prompt Optimization Guide](../Vapi%20Prompt%20Optimization%20Guide.md) so structure, guardrails, and voice-specific habits stay consistent across agents.

## Recommended Structure

```markdown
# Identity & Purpose

Who the assistant is and what it does.

# Guardrails

Hard rules that override everything else:

- Scope limits (what topics to handle)
- Data protection (what NOT to collect)
- Abuse handling
- Off-topic deflection
- Fabrication prohibition

# Primary Objectives

Numbered list of what the assistant should accomplish.

# Personality

Tone, style, language constraints.

# Response Guidelines

How to speak, confirm information, format numbers/prices, etc.

# Context

## Business Knowledge Base

Static facts: hours, services, contact info, service areas.

## Customer Context

Dynamic variables: {{ customer.number }}, current date/time.

# Workflow

## STEP 1: ...

## STEP 2: ...

## STEP 3: ...

Detailed step-by-step conversation flow.

# Error Handling

What to do when things go wrong (tool failures, repeated misunderstandings, etc.).

# Example Flows

Concrete example conversations showing expected behavior.
```

## Tips

- **One question at a time** — Voice agents should never ask multiple questions
- **Confirm critical fields** — Always repeat back names, phone numbers, addresses
- **Use SSML** — `<break time='0.5s'/>`, `<flush/>`, `<spell>text</spell>` for voice control
- **E.164 phone format** — Always store as `+1XXXXXXXXXX`
- **Guard against jailbreaks** — Include identity lock and prompt protection sections
- **Template variables** — Use `{{ customer.number }}` for caller phone, `{{"now" | date: "%A, %B %d, %Y"}}` for date/time
- **Tool call announcements** — Tell the user before calling tools: "Let me check that for you"
- **Transfer pattern** — Always speak first, then call transfer tool (two-step: say message, then tool call)

## Transfer to Human

Two-step pattern (speak first, then call tool):

In the system prompt:

```
When transferring to human:
1. First: Speak transfer message ending with <break time='0.5s'/><flush/>
2. Second: Call transfer_call with no spoken text
```
