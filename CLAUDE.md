# Project Rules For Claude

This repository uses two instruction sources for Claude:

1. `AGENTS.md` is the primary, comprehensive guide for this codebase.
2. `CLAUDE.md` contains Claude-specific reinforcement and policy reminders.

When both files exist, follow both. If guidance overlaps, treat `AGENTS.md` as the canonical project playbook and use this file to reinforce Claude-specific behavior.

---

## ⚠️ CRITICAL SAFETY RULES — read before any direct Vapi API call

### Vapi PATCH on nested objects is REPLACE, not deep-merge

**The Vapi PATCH API does NOT deep-merge nested objects. When you PATCH a nested object (`model`, `voice`, `transcriber`, `messagePlan`, `analysisPlan`, `artifactPlan`, `voicemailDetection`, `startSpeakingPlan`, `stopSpeakingPlan`) with a partial body, the API REPLACES the entire object — wiping every field you didn't include.**

This wiped three live-production assistants' system prompts on 2026-05-13 (gitops-mudflap iForm barge fleet). The PATCH was `{"model": {"model": "gpt-4.1", "provider": "openai", "maxTokens": 260, "temperature": 0.3, "toolIds": [...]}}` — looked complete, but did NOT include `model.messages`. Result: prompts gone, live calls ran with empty system prompt until the operator forced a restore.

**Mandatory workflow for any direct API PATCH against a nested object:**

```bash
# 1. GET the full resource first
ASSISTANT=$(curl -H "Authorization: Bearer $VAPI_TOKEN" https://api.vapi.ai/assistant/$id)

# 2. Modify in place — keep every other field
MODEL=$(echo "$ASSISTANT" | jq '.model | .model = "gpt-4.1"')

# 3. PATCH the COMPLETE nested object back
curl -X PATCH -H "Content-Type: application/json" \
  -d "{\"model\": $MODEL}" \
  https://api.vapi.ai/assistant/$id

# 4. Re-GET and verify EVERY field you cared about — not just the one you changed
```

**The "I patched X and X came back correct" check is NOT sufficient.** Vapi can replace the rest of the nested object even when X looks right in the response. Verify the fields you DIDN'T touch survived too — especially `model.messages` (system prompt), `model.toolIds`, `model.knowledgeBase`, and any nested config under `voice` / `transcriber`.

**When in doubt, use `npm run push -- <env>` instead of direct API PATCH.** The gitops engine constructs the full payload from local YAML automatically. Only fall back to direct curl PATCH when the engine is silently dropping specific fields (the 2026-04-26 `eagerEotThreshold` engine bug and the 2026-05-13 silent-push class). Even then, GET-modify-PATCH-verify.

See `docs/learnings/voice-providers.md` for related "property X should not exist" 400 gotchas (e.g. `voice.enableSsmlParsing` is rejected on `provider: vapi` voices) — those failures are loud; the PATCH-is-REPLACE failure is silent and far more dangerous.

---

## Required Reading Order

1. Read `AGENTS.md` first.
2. Then read this file (`CLAUDE.md`) for additional policy constraints.
3. When configuring or debugging any resource, load only the relevant learnings file — not the whole folder:
   - Assistants → `docs/learnings/assistants.md`
   - Tools → `docs/learnings/tools.md` (also covers tool/SO dedup behavior on push)
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
   - Outbound calling agents → `docs/learnings/outbound-agents.md`
   - Outbound Call Campaigns (CSV bulk-dial) → `docs/learnings/outbound-campaigns.md`
   - Voicemail detection → `docs/learnings/voicemail-detection.md`
   - Call time limits / graceful ending → `docs/learnings/call-duration.md`
   - Voice provider field cheat-sheet → `docs/learnings/voice-providers.md`
   - YAML authoring conventions, .vapi-ignore lifecycle → `docs/learnings/yaml-conventions.md`

This list mirrors the "Learnings & recipes" table in `AGENTS.md`. Keep both in sync — if you add a new learnings file, update both files plus `docs/learnings/README.md`.

## Where new knowledge goes

Per-resource tips/recipes/troubleshooting → `docs/learnings/<topic>.md`. Engine-friction log (push/pull/state/cleanup pain points + their fixes) → `improvements.md`. Code-level rationale → comments only when the *why* is non-obvious; never reference PR/issue numbers in code comments (they rot). One-time onboarding/install → `README.md`. When unsure, default to `docs/learnings/`. The full convention table lives in `AGENTS.md` under "Where new knowledge goes" — read it once, then this reminder is enough.

## Improvements log

This repo maintains an upstream-only running log at `improvements.md` (repo
root). It tracks engine friction, footguns, and improvement ideas surfaced
during real customer work — both before and after fixes land.

**When you (Claude or human) hit something that makes you go "this should be
better," append or update an entry in `improvements.md` in the same change.**
The format is **Problem → Current behavior → Risk → Current mitigation →
Possible fix → Status**, ordered by severity / blast radius. Cite source
file paths with line numbers so future readers can verify your claims.

When a fix lands, mark the entry `[RESOLVED YYYY-MM-DD] (#<PR-number>)` at
the top — don't delete it. The history is the point.

Customer-fork logs (`gitops-mudflap/improvements.md`,
`gitops-amazon3p/improvements.md`) feed upstream: when an entry there is
generic enough to apply across customers, surface it here in the same
revision.

## Test-Call CLI Notes

When debugging a customer issue with `npm run call -- <org> -s <squad>`:

- Assistant utterances render as one coalesced line per turn (chunked TTS finals are buffered for 600 ms before flushing). If you need to see every raw final fragment for a transcriber/TTS investigation, lower or zero out `COALESCE_TIMEOUT_MS` in `src/call.ts`.
- `mpg123` `buffer underflow` stderr warnings are filtered out by the npm script wrapper. They are normal operational noise on macOS, not errors.
- Tool calls, handoffs (`handoff_to_*`), tool results, status transitions, hang warnings, and transfer events render as distinct emoji-prefixed lines (`🔧`, `🔀`, `✅`, `❌`, `📞`, `⚠️`). Use these to trace squad routing without leaving the terminal for the dashboard.
- High-frequency events (`conversation-update`, `model-output`, `function-call`, `user-interrupted`) are silently dropped by default. Set `VAPI_CALL_DEBUG=1` to surface them as `🔍 [debug] <type>: <preview>` lines when enumerating new event shapes.
