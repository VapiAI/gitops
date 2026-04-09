# Gotchas & Best Practices

Non-obvious behaviors, silent defaults, and foot-guns in the Vapi backend that affect how your YAML/JSON resources behave at runtime. This is a companion to the API reference — it covers what the docs _don't_ tell you.

Each file in this directory covers a specific resource type so you can load only the context you need:

| File | What it covers |
|------|----------------|
| [tools.md](tools.md) | apiRequest, function, transferCall, endCall, handoff, code tools; tool messages; strict mode |
| [assistants.md](assistants.md) | Model defaults, voice, transcriber, firstMessage, hooks, idle messages, endpointing, interruption, analysis, artifacts, background sound, server messages, HIPAA, tool resolution |
| [squads.md](squads.md) | Name uniqueness, tools:append, assistantDestinations, handoff context, override merge order |
| [structured-outputs.md](structured-outputs.md) | Schema type gotchas, assistant_ids, default models, target modes |
| [simulations.md](simulations.md) | Personalities, evaluation comparators, chat-mode gotcha, missing references |
| [webhooks.md](webhooks.md) | Default server messages, timeouts, unreachable servers, credential resolution, payload shape |

**When to read these:** Before creating or modifying any resource file in `resources/<env>/`. These gotchas document behavior that the API reference and dashboard don't make obvious.
