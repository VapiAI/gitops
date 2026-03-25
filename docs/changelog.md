# Changelog

Use this file to track meaningful configuration changes to assistants, tools, squads, and related resources.

## How To Use

- Add a new dated section at the top for each meaningful change set.
- Include what changed, why it changed, and expected impact.
- Group entries by resource type when possible.

---

## YYYY-MM-DD

### Added
- [assistants] Added `resources/assistants/example-agent.md` for new intake flow.

### Changed
- [tools] Updated `resources/tools/example-tool.yml` parameters to include `reasonCode`.
- [squads] Updated `resources/squads/example-squad.yml` handoff routing logic.

### Fixed
- [assistants] Corrected prompt guardrails in `resources/assistants/example-agent.md`.

### Notes
- Follow-up action or migration notes (if any).

---

## 2026-03-25

### Added
- [testing] Added `scripts/mock-vapi-webhook-server.ts` to receive and inspect webhook events locally.
- [tooling] Added `npm run mock:webhook` for quickly running the local webhook receiver.

### Changed
- [docs] Updated `AGENTS.md` mock-server guidance to include core `serverMessages` event types (`speech-update`, `status-update`, `end-of-call-report`) and `ngrok` tunnel usage for local callback testing.

### Notes
- The mock server includes `GET /health`, `GET /events`, and `POST /webhook` routes.
- `tool-calls` requests receive a basic mocked `results` response to keep test flows unblocked.
