# Learnings

Non-obvious behaviors, proven recipes, and troubleshooting guides for the Vapi platform. This is a companion to the API reference — it covers what the docs don't tell you.

Each file targets a specific topic so you can load only the context you need.

---

## Quick Routing: What are you working on?

| If you're working on... | Read this |
|------------------------|-----------|
| Creating or editing an assistant | [assistants.md](assistants.md) |
| Configuring tools (apiRequest, function, transferCall, handoff, code, endCall) | [tools.md](tools.md) |
| Setting up a squad / multi-agent handoffs | [squads.md](squads.md) |
| Transfers not working | [transfers.md](transfers.md) |
| Structured outputs or post-call analysis | [structured-outputs.md](structured-outputs.md) |
| Writing simulations or test suites | [simulations.md](simulations.md) |
| Webhook / server configuration | [webhooks.md](webhooks.md) |
| Making your agent faster | [latency.md](latency.md) |
| Adding fallback providers (transcriber, voice, error hooks) | [fallbacks.md](fallbacks.md) |
| Using your own Azure OpenAI credentials with regional failover | [azure-openai-fallback.md](azure-openai-fallback.md) |
| Building a multilingual agent (English/Spanish, language switching) | [multilingual.md](multilingual.md) |
| Streaming audio via WebSocket transport | [websocket.md](websocket.md) |
| Building an outbound calling agent | [outbound-agents.md](outbound-agents.md) |
| Bulk-dialing from a CSV (Outbound Call Campaigns) | [outbound-campaigns.md](outbound-campaigns.md) |
| Voicemail detection / VM vs human classification | [voicemail-detection.md](voicemail-detection.md) |
| Enforcing call time limits / graceful call ending | [call-duration.md](call-duration.md) |

---

## Full Index

### Configuration Reference

Gotchas and silent defaults for each resource type:

| File | What it covers |
|------|----------------|
| [tools.md](tools.md) | apiRequest, function, transferCall, endCall, handoff, voicemail, dtmf, code tools; tool messages; strict mode |
| [assistants.md](assistants.md) | Model defaults, voice, transcriber, firstMessage, outbound modes, voicemailMessage, hooks, idle messages, endpointing, interruption, analysis, artifacts, background sound, server messages, HIPAA, tool resolution |
| [squads.md](squads.md) | Name uniqueness, tools:append, assistantDestinations, handoff context, contextEngineeringPlan, VM detection relay pattern, override merge order |
| [structured-outputs.md](structured-outputs.md) | Schema type gotchas, assistant_ids, default models, target modes, KPI patterns |
| [simulations.md](simulations.md) | Personalities, evaluation comparators, chat-mode gotcha, missing references |
| [webhooks.md](webhooks.md) | Default server messages, timeouts, unreachable servers, credential resolution, payload shape |

### Troubleshooting Runbooks

Step-by-step diagnostic guides for common problems:

| File | What it covers |
|------|----------------|
| [transfers.md](transfers.md) | Transfers not working: LLM not calling tool, wrong tool type, telephony failures, transient assistant issues |
| [voicemail-detection.md](voicemail-detection.md) | Voicemail vs human classification, detection priority hierarchy, trigger phrases, false positives, beep detection, testing matrix |

### Recipes & Guides

Proven patterns and setup guides:

| File | What it covers |
|------|----------------|
| [outbound-agents.md](outbound-agents.md) | Outbound agent design, IVR navigation (DTMF), opening statements, identity handling, pacing, conversation flow, metrics |
| [outbound-campaigns.md](outbound-campaigns.md) | Outbound Call Campaigns feature: CSV format, dynamic variables (extra columns → `variableValues`), concurrency, scheduling, completion semantics |
| [latency.md](latency.md) | Pipeline latency budget, quick-win matrix, iron triangle, model selection, prompt optimization, endpointing tuning |
| [fallbacks.md](fallbacks.md) | Error-handling hooks, endedReason filters, transcriber/voice fallback chains, phone number fallback |
| [azure-openai-fallback.md](azure-openai-fallback.md) | BYOK Azure OpenAI multi-region setup, credential isolation, region pinning, runtime failover behavior |
| [multilingual.md](multilingual.md) | Three approaches to multilingual agents, provider recommendations, tool message patterns, common pitfalls |
| [websocket.md](websocket.md) | Audio formats, timing rules, silence values, control messages, connection management, error codes |
| [call-duration.md](call-duration.md) | Call time limits, `maxDurationSeconds`, `call.timeElapsed` hooks, graceful shutdown recipes, wrap-up patterns |
