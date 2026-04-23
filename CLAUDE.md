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

## Test-Call CLI Notes

When debugging a customer issue with `npm run call -- <org> -s <squad>`:

- Assistant utterances render as one coalesced line per turn (chunked TTS finals are buffered for 600 ms before flushing). If you need to see every raw final fragment for a transcriber/TTS investigation, lower or zero out `COALESCE_TIMEOUT_MS` in `src/call.ts`.
- `mpg123` `buffer underflow` stderr warnings are filtered out by the npm script wrapper. They are normal operational noise on macOS, not errors.
- Tool calls, handoffs (`handoff_to_*`), tool results, status transitions, hang warnings, and transfer events render as distinct emoji-prefixed lines (`🔧`, `🔀`, `✅`, `❌`, `📞`, `⚠️`). Use these to trace squad routing without leaving the terminal for the dashboard.
- High-frequency events (`conversation-update`, `model-output`, `function-call`, `user-interrupted`) are silently dropped by default. Set `VAPI_CALL_DEBUG=1` to surface them as `🔍 [debug] <type>: <preview>` lines when enumerating new event shapes.
