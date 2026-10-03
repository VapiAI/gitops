# Vapi GitOps — Agent Guide

This repository manages **Vapi voice agents as code**. Assistants, tools,
squads, structured outputs, simulations and evals are files under
`resources/<org>/`, and the CLI (`npm run …`) syncs them to Vapi orgs.

This file is the guide for coding agents (Claude Code reads it through
`CLAUDE.md`; Codex and Cursor read it directly). Keep it short: detail lives
in [`docs/guides/`](docs/guides/) and [`docs/learnings/`](docs/learnings/README.md),
and you should open those files when a task needs them.

---

## Which repository are you in?

Some rules depend on whether this is the upstream template or a customer's
own deployment. Check `docs/changelog.md`:

- **Upstream template** — `docs/changelog.md` still contains the placeholder
  heading `## YYYY-MM-DD`. Changes here are usually to the engine or docs.
  Don't edit `docs/changelog.md`. Record engine friction in `improvements.md`
  (see [Changing the engine](#changing-the-engine)).
- **Customer deployment** — the placeholder has been replaced with dated
  entries. For every significant configuration change, add an entry to
  `docs/changelog.md` in the same change: a `YYYY-MM-DD` section, the resource
  type and file paths, and what changed, why, and the expected impact.
  Significant means assistant prompts or settings, tools, squad members or
  routing, and structured outputs or simulations that change behaviour.

---

## Safety rules (read before doing anything)

**1. Ask before you change a live org or delete anything.** Resources here run
real phone calls. Get an explicit yes from the human, for this specific
change, before running:

| Command | Why it needs a yes |
| --- | --- |
| `npm run apply`, `npm run push` | Changes live assistants |
| `npm run promote -- … --apply` | Changes the next org (often production) |
| `npm run rollback -- <org> --to …` | Reverts live resources |
| `npm run cleanup -- <org> --force --confirm <org>` | Deletes platform resources |
| `npm run pull -- <org> --force` | Overwrites local edits |
| `--allow-new-files`, `--overwrite`, `--resolve=ours\|theirs` | Bypass a safety check (see rule 6) |
| `npm run call`, `npm run sim`, live `npm run check` | Place calls or run simulations that cost minutes |

Safe to run without asking: `npm run validate`, `npm run audit`,
`npm run check -- … --dry-run`, `npm run promote` without `--apply` (a plan),
plain `npm run pull` (it never overwrites local edits), `npm run push -- <org>
--dry-run`, `npm run build`, `npm test`.

**2. Never handle API keys.** Don't ask the human to paste a key into chat,
don't print or read out `.env.*` files, never pass a key as a command-line
argument, and never commit `.env.*`. Keys live in `.env.<org>` (gitignored)
or the environment.

**3. Reference resources by ID, never by UUID.** A resource's ID is its path
under the type folder without the extension (`tools/lookup-patient.yml` is
`lookup-patient`). Credentials are referenced by **name**. The engine resolves
names to each org's UUIDs; a pasted UUID only works in one org and breaks
promotion.

**4. A direct API `PATCH` replaces nested objects.** The Vapi API does not
deep-merge: PATCHing `model`, `voice`, `transcriber`, `messagePlan`,
`analysisPlan`, `artifactPlan`, `voicemailDetection`, `startSpeakingPlan` or
`stopSpeakingPlan` with a partial object wipes every field you left out. A
partial `model` PATCH that omitted `model.messages` once erased the system
prompts of live production assistants. Prefer `npm run apply`, which sends
complete payloads from the files. If you must call the API directly:

```bash
# 1. GET the full resource
ASSISTANT=$(curl -s -H "Authorization: Bearer $VAPI_PRIVATE_API_KEY" https://api.vapi.ai/assistant/$id)
# 2. Modify the nested object in place, keeping every other field
MODEL=$(echo "$ASSISTANT" | jq '.model | .model = "gpt-4.1"')
# 3. PATCH the COMPLETE nested object back
curl -X PATCH -H "Authorization: Bearer $VAPI_PRIVATE_API_KEY" -H "Content-Type: application/json" \
  -d "{\"model\": $MODEL}" https://api.vapi.ai/assistant/$id
# 4. GET again and check the fields you did NOT change survived (model.messages, model.toolIds, …)
```

**5. `.ts` resource files execute code** when loaded — in `validate`,
promotion plans and PR checks too. Treat them like code in review.

**6. Don't bypass a safety check to make a command pass.** The new-file check,
per-resource conflict prompts and cleanup confirmation exist to stop
duplicates and data loss. When one stops a command, show its message to the
human and let them decide.

---

## First-time setup (no terminal)

You usually run without a TTY, so **don't run bare `npm run setup`** — the
wizard needs a terminal. Instead:

1. `nvm use` (or check `node --version` satisfies `engines` in `package.json`), then `npm ci`.
2. **Get the API key without handling it.** Ask the human to create
   `.env.<org>` from `.env.example` and put a Vapi **private API key** in
   `VAPI_PRIVATE_API_KEY`, or confirm it's already exported. Point them to
   https://dashboard.vapi.ai/org/api-keys → **Private API Keys** (a public key
   won't work).
3. Ask whether to download the org's existing resources:
   - Managing an existing org → `npm run setup -- <org>` (`--resources all`, the default).
   - Authoring from scratch → `npm run setup -- <org> --resources none` (state only, no files).
   Add `--region eu` for EU orgs if auto-detection picks the wrong one.
4. Verify: `npm run validate -- <org>` passes, and `resources/<org>/` plus
   `.vapi-state.<org>.json` exist.
5. Commit `resources/<org>/` and `.vapi-state.<org>.json`. Never commit `.env.<org>`.

If setup says the org is "already set up locally", don't delete anything to
work around it — run `npm run pull -- <org>`, or ask the human.

**Working in an existing repository for the first time?** Run a plain
`npm run pull -- <org>` before your first deploy. It seeds your local drift
baselines (`.vapi-state-hash/`, which is per-developer and gitignored);
until then, the engine can't tell your edits from dashboard edits as
precisely.

---

## Making a change

1. **Read the relevant learnings file** before configuring or debugging a
   resource (see [Learnings](#learnings-and-where-knowledge-goes)). Before
   writing or changing a system prompt, read
   [Writing system prompts](docs/guides/writing-prompts.md) and the
   [Vapi Prompt Optimization Guide](docs/Vapi%20Prompt%20Optimization%20Guide.md).
2. **Edit the files** under `resources/<org>/`. Settings and examples:
   [resource reference](docs/guides/resource-reference.md); tested files to
   copy from: [`examples/starter/`](examples/starter/README.md).
3. **Validate:** `npm run validate -- <org>` (offline). CI's **Validate
   resources** check runs it for every org on every PR; if that check fails,
   run it locally for the org it names and fix the errors. Don't weaken the
   check or the workflow to get past it.
4. **Build PR checks offline** if `vapi-checks.yml` exists:
   `npm run check -- --all --dry-run`. Fix anything it reports.
5. **Deploy only with a yes** (safety rule 1): `npm run apply -- <org>`, or
   scoped to files: `npm run apply -- <org> resources/<org>/assistants/my-agent.md`.
6. **Verify** with the human's agreement: `npm run call -- <org> -a <name>` or
   `npm run sim -- <org> --suite <name> --target <name>`.
7. **Commit** the resource files and `.vapi-state.<org>.json`.

**Why `apply`, not `push`:** `apply` pulls the platform's current state, merges
your local edits, then pushes, so it never silently overwrites changes made in
the dashboard. Raw `push` skips the pull; use it only right after a pull, and
dry-run it first (`--dry-run`). When a resource changed both locally and in
the dashboard, `apply` asks about that resource alone in a terminal; in CI or
piped runs it's blocked unless `--resolve=ours|theirs|fail` is passed — ask
the human which.

**When a deploy stops at the new-file check** ("no state-file UUID mapping"),
the engine can't tell whether each listed file is new, a rename, or stale.
Show the list to the human and ask them to classify each file. Pass
`--allow-new-files` only once they confirm every file is genuinely new. For a
rename, see [Renaming](#naming-and-renaming); delete stale files.

If something goes wrong: `npm run rollback -- <org> --list`, then (with a yes)
`--to <timestamp>`. Details for every workflow:
[Everyday workflows](docs/guides/workflows.md);
how sync, conflicts and output icons work:
[How the engine works](docs/guides/how-it-works.md).

---

## Quick reference

| I want to… | Do this |
| --- | --- |
| Edit an assistant's system prompt | Edit the Markdown body of `resources/<org>/assistants/<name>.md` |
| Change assistant settings | Edit the YAML frontmatter of the same file |
| Add a tool / assistant / squad | Create `resources/<org>/tools/<name>.yml`, `assistants/<name>.md`, `squads/<name>.yml` |
| Add post-call analysis | Create `resources/<org>/structuredOutputs/<name>.yml` and list it in the assistant's `artifactPlan.structuredOutputIds` |
| Write simulation tests | Create files under `resources/<org>/simulations/` (see [Simulations](#simulations-and-pr-checks)) |
| Check files offline | `npm run validate -- <org>` |
| Deploy (with a yes) | `npm run apply -- <org> [paths]` |
| Sync platform changes down | `npm run pull -- <org>` (never `--force` without a yes) |
| Pull one known resource | `npm run pull -- <org> --type assistants --id <uuid>` |
| Find drift between files, state and the platform | `npm run audit -- <org>` |
| Preview a push | `npm run push -- <org> --dry-run` |
| Build PR check payloads offline | `npm run check -- <check> --dry-run` (or `--all`) |
| Plan a promotion | `npm run promote -- --pipeline <p> --from <org> --to <org>` |
| List snapshots to roll back to | `npm run rollback -- <org> --list` |
| Find platform resources with no file | `npm run cleanup -- <org>` (dry run; deleting needs `--force --confirm <org>` and a yes) |

All commands and flags: [Commands](docs/guides/commands.md). Only `setup`,
`apply`, `pull`, `push`, `cleanup` and `call` have interactive modes, and you
should always pass an org and flags instead.

---

## Resources and references

Each org is a folder: `resources/<org>/{assistants,tools,squads,structuredOutputs,evals,simulations/{personalities,scenarios,tests,suites}}`.
Assistants are `.md` (YAML frontmatter plus the system prompt as the body) or
`.yml`; everything else is `.yml`. Any resource can also be a `.ts` file that
default-exports the object (safety rule 5).

| From | Field | References | Example |
| --- | --- | --- | --- |
| Assistant | `model.toolIds[]` | Tool files | `- lookup-patient` |
| Assistant | `artifactPlan.structuredOutputIds[]` | Structured output files | `- call-summary` |
| Structured output | `assistant_ids[]` | Assistant files | `- receptionist` |
| Handoff tool | `destinations[].assistantId` | Assistant files | `assistantId: scheduler` |
| Squad member | `assistantId` | Assistant files | `assistantId: receptionist` |
| Squad `tools:append` handoff | `destinations[].assistantName` | The target assistant's `name` | `assistantName: Scheduler` |
| Scenario evaluation | `structuredOutputId` | Structured output files | `structuredOutputId: booking-confirmed` |
| Simulation | `personalityId`, `scenarioId` | Personality and scenario files | `scenarioId: books-cleaning` |
| Suite | `simulationIds[]` | Simulation files | `- books-cleaning-calm` |
| Any server block | `credentialId` | A credential **name** in the org | `credentialId: my-api-credential` |

The engine resolves IDs and credential names to each org's UUIDs on push.

### Naming and renaming

- **Files you create keep their names.** Resources pulled from the platform
  that have no file yet are written as `<name>-<first 8 characters of the UUID>`
  (for example `intake-agent-a1b2c3d4.md`).
- **The filename is a stable handle**, independent of the dashboard `name`.
  The state file maps filename → UUID, and pulls update a file's content, never
  its name.
- Tool function names use `snake_case` (`book_appointment`); assistant names
  use natural language (`Intake Assistant`).

| To rename… | Do this |
| --- | --- |
| The display name | Change `name` in the file (or in the dashboard, then pull). The filename stays. |
| The file itself | A renamed file has no state entry, so the next deploy stops at the new-file check. Either keep the old filename, or (with the human's agreement) deploy it as new with `--allow-new-files` and delete the old platform resource with `npm run cleanup -- <org> --force --confirm <org>`. |

### Excluding resources (`.vapi-ignore`)

`resources/<org>/.vapi-ignore` lists platform resources this repo must not
manage, as gitignore-style patterns (see `resources/.vapi-ignore.example`).
Matched resources are skipped on pull and push, and neither push nor
`npm run cleanup` deletes them. A resource that references an ignored one is a
validation error.

---

## Simulations and PR checks

- A **scenario** needs `name`, `instructions`, and at least one evaluation
  (a judge). Over chat, at least one judge must be `required: true` and text
  based. Add `toolMocks` (`toolName` + `result`) for every tool the scenario
  will call. A **personality** needs an `assistant` config; a **simulation**
  pairs a `personalityId` with a `scenarioId`; a **suite** lists
  `simulationIds`. Tested examples: `examples/starter/resources/starter/simulations/`.
- **PR checks** (`vapi-checks.yml`) run suites against the branch's own files,
  with tools mocked and nothing deployed. Always run
  `npm run check -- <check> --dry-run` after changing a target or its tests;
  it fails, naming the field, on anything it can't run safely (for example an
  SMS tool, or a handoff outside the squad). A live check needs a yes.
- Learnings: [simulations](docs/learnings/simulations.md). Setup and the
  refusal table: [PR checks](docs/guides/pr-checks.md).

## Promotion

`promotion.yml` defines one-way pipelines between orgs (for example dev →
staging → production). Planning is read-only:
`npm run promote -- --pipeline <p> --from <a> --to <b>`. Applying (`--apply`)
changes the next org and needs a yes. An org can require a PR check to pass
before anything is promoted out of it (`orgs.<org>.check: <name>`).
Full guide: [Promotion](docs/guides/promotion.md).

---

## Learnings and where knowledge goes

Before configuring or debugging a resource, read the matching file. Load only
what you need:

| Working on | Read |
| --- | --- |
| Assistants (model, voice, transcriber, hooks) | `docs/learnings/assistants.md` |
| Tools (apiRequest, function, transferCall, handoff, code) | `docs/learnings/tools.md` |
| Squads / multi-agent handoffs | `docs/learnings/squads.md` |
| Transfers not working | `docs/learnings/transfers.md` |
| Structured outputs / post-call analysis | `docs/learnings/structured-outputs.md` |
| Simulations / test suites | `docs/learnings/simulations.md` |
| Webhooks / server config | `docs/learnings/webhooks.md` |
| Latency optimization | `docs/learnings/latency.md` |
| Fallback providers / error hooks | `docs/learnings/fallbacks.md` |
| Azure OpenAI BYOK with regional failover | `docs/learnings/azure-openai-fallback.md` |
| Multilingual agents (English/Spanish) | `docs/learnings/multilingual.md` |
| WebSocket audio streaming | `docs/learnings/websocket.md` |
| Building outbound calling agents | `docs/learnings/outbound-agents.md` |
| Bulk-dialing from a CSV (Outbound Call Campaigns) | `docs/learnings/outbound-campaigns.md` |
| Voicemail detection / VM vs human classification | `docs/learnings/voicemail-detection.md` |
| Enforcing call time limits / graceful call ending | `docs/learnings/call-duration.md` |
| Voice provider field cheat-sheet (Cartesia vs 11labs vs OpenAI etc.) | `docs/learnings/voice-providers.md` |
| YAML authoring conventions, .vapi-ignore lifecycle | `docs/learnings/yaml-conventions.md` |
| What pull/push/apply do in every drift & existence scenario | `docs/learnings/sync-behavior.md` |

**Where new knowledge goes:**

| Kind of knowledge | Home | Convention |
| --- | --- | --- |
| Platform gotchas, recipes, troubleshooting | `docs/learnings/<topic>.md` | One file per topic. A new file needs a row in the table above and in `docs/learnings/README.md` (`npm test` checks the table above). |
| Sync-engine pain points and fixes | `improvements.md` | Problem → Current behavior → Risk → Current mitigation → Possible fix → Status. Mark `[RESOLVED YYYY-MM-DD] (#<PR>)` when fixed; never delete entries. |
| Why code works the way it does | Code comments | Only when the why isn't obvious. Never cite PR/issue numbers or line numbers; they rot. |
| Setup and orientation for people | `README.md` and `docs/guides/` | Keep the README short; depth goes in a guide. |
| A customer deployment's config history | `docs/changelog.md` | Customer deployments only (see [Which repository](#which-repository-are-you-in)). |

When unsure, default to `docs/learnings/`.

---

## Changing the engine

For changes under `src/`, `tests/` or `.github/`:

- Run `npm run build` (type-checks `src/` and `tests/`) and `npm test` before
  you finish. Tests use `node:test` and must never call the real Vapi API —
  use a local HTTP stub, as the existing tests do.
- Changing a command's flags or behaviour? Update
  [`docs/guides/commands.md`](docs/guides/commands.md) and the README command
  table in the same change.
- Changing an example under `examples/`? Doc snippets that start with
  `# examples/<path>` must match the file exactly (`npm test` checks).
- Commit messages follow Conventional Commits (`fix(pull): …`, `docs: …`).
- When you hit engine friction ("this should be better"), add or update an
  entry in `improvements.md` in the same change. Upstream's log collects
  entries from customer forks' logs when they apply to everyone.

---

## Reference

| Topic | Read |
| --- | --- |
| Every resource setting, with examples | [Resource reference](docs/guides/resource-reference.md) |
| Minimal tested files | [File formats](docs/guides/file-formats.md), [`examples/starter/`](examples/starter/README.md) |
| System prompts | [Writing system prompts](docs/guides/writing-prompts.md), [Vapi Prompt Optimization Guide](docs/Vapi%20Prompt%20Optimization%20Guide.md) |
| Commands, flags, test-call output | [Commands](docs/guides/commands.md) |
| Sync, conflicts, drift, output icons | [How the engine works](docs/guides/how-it-works.md), [sync behavior](docs/learnings/sync-behavior.md) |
| Environment variables and config files | [Configuration](docs/guides/configuration.md) |
| Errors | [Troubleshooting](docs/guides/troubleshooting.md) |
| Complete API schemas | [Vapi API reference](https://docs.vapi.ai/api-reference) |
