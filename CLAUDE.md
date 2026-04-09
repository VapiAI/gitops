# Project Rules For Claude

This repository uses two instruction sources for Claude:

1. `AGENTS.md` is the primary, comprehensive guide for this codebase.
2. `CLAUDE.md` contains Claude-specific reinforcement and policy reminders.

When both files exist, follow both. If guidance overlaps, treat `AGENTS.md` as the canonical project playbook and use this file to reinforce Claude-specific behavior.

## Required Reading Order

1. Read `AGENTS.md` first.
2. Then read this file (`CLAUDE.md`) for additional policy constraints.
3. When configuring or debugging any resource, load only the relevant learnings file — not the whole folder:
   - Assistants → `docs/learnings/assistants.md`
   - Tools → `docs/learnings/tools.md`
   - Squads → `docs/learnings/squads.md`
   - Transfers not working → `docs/learnings/transfers.md`
   - Structured outputs → `docs/learnings/structured-outputs.md`
   - Simulations → `docs/learnings/simulations.md`
   - Webhooks → `docs/learnings/webhooks.md`
   - Latency issues → `docs/learnings/latency.md`
   - Fallbacks / error handling → `docs/learnings/fallbacks.md`
   - Azure OpenAI BYOK → `docs/learnings/azure-openai-fallback.md`
   - Multilingual agents → `docs/learnings/multilingual.md`
   - WebSocket transport → `docs/learnings/websocket.md`
   - Call time limits / graceful ending → `docs/learnings/call-duration.md`
