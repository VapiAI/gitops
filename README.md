# Vapi GitOps

Manage Vapi resources via Git using YAML/Markdown as the source-of-truth.

## Why GitOps?

|                       | Dashboard / Ad-hoc API                                          | GitOps                                     |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| **History**           | Limited visibility of who changed what                          | Full git history with blame                |
| **Review**            | Changes go live immediately (can break things)                  | PR review before deploy                    |
| **Rollback**          | Manual recreation                                               | `git revert` + push                        |
| **Environments**      | Tedious to copy-paste between envs                              | Same config, different state files         |
| **Collaboration**     | One person at a time. Need to duplicate assistants, tools, etc. | Team can collaborate and use git branching |
| **Reproducibility**   | "It worked on my assistant!"                                    | Declarative, version-controlled            |
| **Disaster Recovery** | Hope you have backups                                           | Re-apply from git                          |

### Supported Resources

| Resource               | Status | Format                               |
| ---------------------- | ------ | ------------------------------------ |
| **Assistants**         | ✅     | `.md` (with system prompt) or `.yml` |
| **Tools**              | ✅     | `.yml`                               |
| **Structured Outputs** | ✅     | `.yml`                               |
| **Squads**             | ✅     | `.yml`                               |
| **Personalities**      | ✅     | `.yml`                               |
| **Scenarios**          | ✅     | `.yml`                               |
| **Simulations**        | ✅     | `.yml`                               |
| **Simulation Suites**  | ✅     | `.yml`                               |
| **Evals**              | ✅     | `.yml`                               |

---

## Quick Start

### Prerequisites

- Node.js 20.12+ or 22.13+ (`.nvmrc` pins 22 — run `nvm use`)
- A Vapi **private API key** for each org you want to manage — create or copy one at [dashboard.vapi.ai/org/api-keys](https://dashboard.vapi.ai/org/api-keys) under **Private API Keys**

### Installation

```bash
npm install
```

### Interactive Setup

The easiest way to get started is the interactive setup wizard:

```bash
npm run setup
```

This will:

1. Prompt for your Vapi private API key (with region auto-detection)
2. Ask for an org/folder name (e.g. `my-org`, `production`)
3. Let you choose which resources to download (all or pick individually)
4. Detect dependencies and offer to download them too
5. Create `.env.<org>` and `resources/<org>/` for you

You can run setup multiple times to add more orgs.

### Non-interactive Setup (AI agents, CI)

The wizard needs a real terminal. Coding agents (Claude Code, Cursor, Codex, …) and CI
run commands without one, so pass the org name to skip every prompt:

```bash
# Option A — a human creates the env file, so the key never passes through the agent
cp .env.example .env.my-org          # then paste the private API key into VAPI_PRIVATE_API_KEY
npm run setup -- my-org

# Option B — the key is already in the environment (CI secret, shell export)
VAPI_PRIVATE_API_KEY=... npm run setup -- my-org
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--region us\|eu` | `VAPI_BASE_URL` if set, else auto-detect (US, then EU) | Which Vapi API to use |
| `--resources all\|none` | `all` | `all` downloads every resource into `resources/<org>/`; `none` only seeds `.vapi-state.<org>.json` (use when you'll author from scratch) |

The private API key is never accepted as a command-line flag (it would leak into shell history and
agent transcripts). Non-interactive setup also refuses to run if `resources/<org>/` or
`.vapi-state.<org>.json` already exists — use `npm run pull -- <org>` to refresh an existing org.

### Commands

Every command works in two modes:

- **Interactive** — run without arguments, get prompted for org and resources
- **Direct** — pass an org slug and flags for scripting / CI

| Command | Interactive | Direct | One-liner |
| --- | --- | --- | --- |
| `npm run setup` | ✅ | — | First-time org wizard — creates `.env.<org>` and `resources/<org>/`. |
| `npm run validate` | — | `npm run validate -- <org>` | Schema-check local YAML/MD with no network call. **Run before every `apply`.** |
| `npm run audit` | — | `npm run audit -- <org> [--type <t>]` | Read-only drift detector — orphan local YAML, state ghosts, UUID collisions, content-identical clusters, sibling base-slug clusters, dashboard orphans, assistants with inline `model.tools`. Exit 1 on any finding; safe to wire into CI. |
| `npm run promote` | — | `npm run promote -- --pipeline <name> --from <org> --to <org> [--apply]` | Plan or apply a forward-only, dependency-aware promotion defined by `promotion.yml`. |
| `npm run apply` | ✅ | `npm run apply -- <org> [--force]` | **Default deploy verb.** Pull → merge → push in one safe pass; resilient against dashboard drift. |
| `npm run pull` | ✅ | `npm run pull -- <org> [flags]` | Fetch remote state into local files / state file. Local-first by default — won't clobber local edits. |
| `npm run push` | ✅ | `npm run push -- <org> [flags]` | Raw push without a pre-pull. Refuses by default when local YAML files lack state entries (orphan-YAML gate); pass `--allow-new-files` to bypass after confirming intent. **Skip unless you just ran `pull` and are certain state is fresh** — otherwise prefer `apply`. |
| `npm run cleanup` | ✅ | `npm run cleanup -- <org> [--force --confirm <org>]` | Inspect (default) or delete orphaned remote resources. Destructive run requires `--confirm <org>`. |
| `npm run rollback` | — | `npm run rollback -- <org> --list` or `--to <ISO>` | Restore from a snapshot in `.vapi-state.<org>.snapshots/` (one is written before every push/apply). |
| `npm run call` | ✅ | `npm run call -- <org> -a <name>` or `-s <squad>` | Start an interactive WebSocket call against an assistant or squad. |
| `npm run sim` | — | `npm run sim -- <org> --suite <name> --target <name> [--timeout <min>]` | Run a simulation suite (or specific simulations) against a deployed assistant/squad. Prints the run link; exits 0 passed, 1 failed, 3 incomplete (timeout, Ctrl-C, missing results). |
| `npm run check` | — | `npm run check -- <check>\|--all [--dry-run] [--changed-since <ref>] [--budget-minutes <n>] [--json <path>]` | Run the `vapi-checks.yml` simulation checks against the files on disk: each target is built inline (tools, handoffs, judges, personalities; tools mocked fail-closed, servers dead-ended) and run in one simulation run per target, so nothing is deployed. Posts `Vapi Evals` commit statuses when run by the PR workflow. `--dry-run` builds the payloads offline (no key, nothing sent; `--print-payload` writes them). Exits 0 passed, 1 failed, 2 config or build error, 3 incomplete (timeout, interrupt, budget, billing). |
| `npm run migrate` | — | `npm run migrate` | One-time, all orgs at once: slim legacy state files to pure `name → uuid` and seed the per-developer `.vapi-state-hash/` baseline store from the old hashes. Required once after upgrading to the hash-store engine — `pull`/`push`/`apply` refuse legacy-shaped state until it runs. Idempotent. |
| `npm run build` | — | — | Type-check the codebase (`tsc --noEmit`). |
| `npm test` | — | — | Run regression tests (`node:test`). |

### Interactive Mode

When you run a command without arguments, you get a fully interactive experience:

```bash
npm run push
# → Select org (if multiple configured)
# → All resources / Let me pick…
# → Searchable multi-select with git status indicators
# → Confirm and execute

npm run pull
# → Select org
# → All resources / Let me pick…
# → Shows which resources are already local (✔)
# → "Overwrite locally modified files?" — defaults to NO (local-first)
# → Confirm and execute

npm run cleanup
# → Select org
# → Dry-run preview of what would be deleted
# → "Proceed with actual deletion?" — defaults to NO
# → Destructive run is gated by both your confirm AND --confirm <org>
```

Navigation:
- **Type** to search/filter resources
- **Space** to toggle the focused row (or toggle the whole group when the cursor is on a header)
- **Ctrl+A** to select/deselect all currently-visible rows
- **Ctrl+G** to toggle every item in the focused group
- **→ / ←** (right / left arrow) to expand or collapse the focused group
- **Enter** to confirm
- **Esc** to clear the search; press again to step back to the previous prompt

### Direct Mode

Pass an org slug as the first argument to skip interactive prompts:

```bash
# Pull everything for an org
npm run pull -- my-org

# Force pull (overwrite local changes)
npm run pull -- my-org --force

# Push only assistants
npm run push -- my-org assistants

# Push a single file
npm run push -- my-org resources/my-org/assistants/my-agent.md

# Pull with bootstrap (state only, no files written)
npm run pull -- my-org --bootstrap

# Pull a single resource by UUID
npm run pull -- my-org --type assistants --id <uuid>

# Call an assistant
npm run call -- my-org -a my-assistant

# Call a squad
npm run call -- my-org -s my-squad
```

---

## Suggested Workflows

Recipes for common situations. Each one is the safe path — there are faster shortcuts, but use them only when you understand the trade-offs. The single most important habit: **prefer `apply` over `push`**, because `apply` refreshes platform state before mutating, protecting you against dashboard edits made between your last pull and your push.

### Daily edit-and-deploy

```bash
# 1. Schema-check locally first — fails fast on YAML shape errors, no network needed.
npm run validate -- <org>

# 2. Deploy via apply: pulls latest platform state, merges with your local
#    changes, then pushes the merged result. Safe against drift.
npm run apply -- <org>
```

### Iterating on a single file

```bash
npm run validate -- <org>
npm run apply -- <org> resources/<org>/assistants/my-agent.md
```

`apply` accepts the same path-scoping as `push`, so you get safety + targeted scope in one command.

### First push into a fresh org

```bash
# Interactive wizard — pick "no resources" if you'll author from scratch.
npm run setup

# Drop your YAML/MD files into resources/<org>/, then:
npm run validate -- <org>
npm run apply -- <org>
```

On a fresh org, `apply`'s pull phase bootstraps `.vapi-state.<org>.json` from the empty dashboard before pushing your local creates.

### Creating new resources after the first push (orphan-YAML gate)

After the initial setup, **`push` refuses by default** when it sees a local YAML file that has no entry in the state file. The engine can't tell whether the file is:

- (a) a NEW resource you intentionally want to create,
- (b) a RENAME of an existing resource (state has the old slug; YAML has the new name), or
- (c) a MOVED file (file copied or restored without state being re-keyed).

Silently treating every orphan as case (a) used to spawn duplicates on the dashboard. The gate halts push with a verbose message listing every orphan, and pairs each orphan with possible "rename source" candidates (state entries with no matching local file that share a base slug).

To proceed when the orphans are genuinely new resources:

```bash
npm run push -- <org> --allow-new-files
```

This works on `apply` too: `npm run apply -- <org> --allow-new-files` propagates the flag through to the push stage.

**For AI agents**: do NOT auto-pass `--allow-new-files` without confirming with the human. The gate's verbose message is designed to be surfaced to the user so they can reclassify each orphan (new vs rename vs cruft). Silent bypass defeats the gate.

Suppressed automatically:
- Explicit `--bootstrap` runs (population-from-scratch is expected to be all-new).
- Files matched by `.vapi-ignore` (the engine wasn't going to upload them anyway).
- Selective push (`-- <path>`) where the orphan is outside the selection.

### Pulling without losing local work

```bash
# Local-first by default — won't overwrite locally modified files.
npm run pull -- <org>

# State-only refresh — re-sync UUID mappings without writing resource files locally.
npm run pull -- <org> --bootstrap

# Pull a single known remote resource by UUID.
npm run pull -- <org> --type assistants --id <uuid>
```

### Live testing what you just deployed

```bash
# Interactive WebSocket call — speak/listen from the terminal.
npm run call -- <org> -a <assistant-name>
npm run call -- <org> -s <squad-name>

# Automated simulation suite against the deployed resource.
npm run sim -- <org> --suite <suite-name> --target <assistant-name>
```

### Recovering from a bad deploy

```bash
# Every push/apply writes a snapshot first. List them:
npm run rollback -- <org> --list

# Re-apply a specific snapshot to undo a deploy:
npm run rollback -- <org> --to <ISO-timestamp>
```

### Cleaning up orphaned dashboard resources

```bash
# Dry-run by default — shows what would be deleted, makes no changes.
npm run cleanup -- <org>

# Destructive run — requires explicit confirmation:
npm run cleanup -- <org> --force --confirm <org>
```

**Surgical alternative when the orphan set includes Vapi-default fixtures** (e.g. the seven undeletable stock simulation personalities — see `docs/learnings/simulations.md`): delete individual resources via direct API call, then refresh state:

```bash
curl -X DELETE -H "Authorization: Bearer $VAPI_PRIVATE_API_KEY" \
  https://api.vapi.ai/assistant/<orphan-uuid>
npm run pull -- <org> --bootstrap
```

This avoids `--force` halting on the first immortal-default 404.

### When to use raw `push` instead of `apply`

Almost never. The only honest case: you just ran `pull`, nothing else has touched the dashboard since, and you need to skip the merge pass for speed. In any multi-developer environment, default to `apply`.

If you do use `push`, dry-run it first:

```bash
npm run push -- <org> --dry-run
```

### Pre-flight checklist before any deploy

1. `git status` — uncommitted changes are intentional?
2. `npm run validate -- <org>` — schema clean?
3. `npm run apply -- <org>` (or `apply -- <org> <path>` for single-file)
4. After: verify with `npm run call -- <org> -a <name>` or a `npm run sim` suite
5. If something looks wrong: `npm run rollback -- <org> --list`

---

## Organization-Based Structure

Resources are scoped by organization (not fixed `dev`/`stg`/`prod` names). Each org gets:

- `.env.<org>` — private API key and base URL
- `.vapi-state.<org>.json` — resource name ↔ UUID mappings (nothing else — committed)
- `.vapi-state-hash/<org>/<uuid>` — last-seen platform content hash per resource, used for drift detection (per-developer, gitignored)
- `resources/<org>/` — all resource files

```
vapi-gitops/
├── .env.my-org                    # Private API key for my-org
├── .env.production                # Private API key for production
├── .vapi-state.my-org.json        # State file for my-org
├── .vapi-state.production.json    # State file for production
├── resources/
│   ├── my-org/                    # Dev/test org resources
│   │   ├── assistants/
│   │   ├── tools/
│   │   ├── squads/
│   │   ├── structuredOutputs/
│   │   ├── evals/
│   │   └── simulations/
│   └── production/                # Production org resources
│       └── (same structure)
```

### Promoting Resources Across Orgs

Copy `promotion.example.yml` to `promotion.yml` and define any number of orgs
in their allowed one-way order. Each pipeline also declares the resource
patterns it owns. Those patterns are a safety boundary: matching destination
files are mirrored, including deletions, while unrelated destination files are
left alone.

#### One-time promotion setup

1. Configure every org with `npm run setup`, using one stable slug per org
   (for example `acme-dev`, `acme-staging`, and `acme-prod`).
2. Run `npm run pull -- <org> --bootstrap` for every org. Commit each
   `.vapi-state.<org>.json`; never commit `.env.<org>` or
   `.vapi-state-hash/`.
3. Copy `promotion.example.yml` to `promotion.yml`. List orgs in forward-only
   release order and set the correct `baseUrl` for each region.
4. Give each pipeline the narrowest resource globs it owns. A pattern is both
   the copy boundary and the deletion boundary; avoid `**/*` unless the whole
   destination org is intentionally a mirror.
5. Choose `bind` or `omit` for credentials and phone numbers in each target
   org. Pull generates stable aliases in `.env.<org>` from resources that
   already exist there; promotion never copies secrets or provisions numbers.
6. Run the read-only plan for each transition before the first apply and
   confirm every create, update, and delete is expected.

```bash
# Read-only plan; no files or APIs change
npm run promote -- --pipeline release --from dev --to staging

# Reconcile files, org-local bindings, UUID state, and Vapi
npm run promote -- --pipeline release --from dev --to staging --apply
```

Promotion copies logical references, not physical UUIDs. Dependencies such as
tools and structured outputs are included before assistants, and the normal
destination push resolves every logical name through
`.vapi-state.<destination>.json`. Existing credentials and phone numbers use
the destination org's binding; their secret material is never copied or
provisioned.

Plan mode performs no file or API writes. Like the rest of this template,
loading a `.ts` resource executes its default-export module so dependencies can
be inspected; only run plans from reviewed branches when TypeScript resources
are present.

The merged `promotion.yml` and resource diff are the reviewed plan. That is why
CI may deliberately pass `--allow-new-files`: the PR already names the pipeline
and limits the files that are authorized to become new destination resources.

#### GitHub Actions

The bundled `Promote Vapi resources` workflow supports both automatic and
manual runs:

1. Commit `promotion.yml`.
2. Add a repository secret named `VAPI_PROMOTION_TOKENS` containing a JSON map
   from org slug to that org's private API key, for example
   `{"dev":"...","staging":"...","prod":"..."}`.
3. Set the repository variable `VAPI_PROMOTION_ENABLED=true` to reconcile all
   adjacent transitions after changes land on `main`. This continuously
   converges the full pipeline in one run, including the final production org.
4. In **Settings → Actions → General → Workflow permissions**, allow GitHub
   Actions to read and write repository contents. If branch protection blocks
   bot pushes to `main`, explicitly allow this workflow or use an equivalent
   reviewed state-commit path.
5. For a controlled single transition, run the workflow manually and provide
   `pipeline`, `from`, and `to`.

Automatic runs watch committed changes to `promotion.yml` and `resources/**`.
A manual run with no inputs reconciles every adjacent transition; supplying
inputs requires all three values and reconciles only that transition.

After a successful apply, the workflow commits destination files and the
updated, UUID-only state files back to `main` with `[skip promotion]`. This
keeps Git as the durable record of each org's posture without committing API
tokens, credential secrets, phone-number provisioning, or developer-local hash
baselines.

For a complete fake dev → staging → production fixture, see the
[dummy multi-org example](examples/cross-org-promotion/README.md). Nothing under
`examples/` is loaded by the engine.

#### Source-org and deletion boundary

Promotion treats `resources/<source>/` in Git as the reviewed desired state for
downstream orgs. It applies destination orgs only; deploy or pull the source org
through its normal GitOps lifecycle separately.

For a mirrored deletion, delete the managed source file in the PR but keep its
committed source-state UUID mapping until the downstream workflow succeeds.
That mapping is the tombstone proving the resource was previously managed, so
an empty or misconfigured source cannot wipe a destination accidentally. The
workflow carries an authorized deletion through every adjacent org in the same
run, removes each destination mapping after its API deletion, and leaves files
outside the pipeline patterns untouched. Reconcile the source org and commit
its cleaned state after downstream deletion completes.

See [sync behavior](docs/learnings/sync-behavior.md#cross-org-promotion-deletions)
for the exact lifecycle.

#### Check before promoting (optional)

Gate an org on a [PR check](#pr-checks-simulations-against-your-branch):
nothing is promoted **out of** it unless the check passes there first.

```yaml
# promotion.yml
orgs:
  example-staging:
    check: staging-core   # a vapi-checks.yml check whose org (and runOrg) is example-staging
```

- Plans print `check  would run staging-core in example-staging (<n> simulations × <t> targets)`
  and run nothing.
- On `--apply`, the check runs against `resources/example-staging/` at the
  promoted commit, in example-staging, with that org's key from
  `VAPI_PROMOTION_TOKENS`, before any file is written to the destination. A
  failure, an incomplete run (timeout, billing) or a build error blocks the
  transition with the run link; transitions that already applied are still
  committed.
- A pass is reused for later transitions out of the same org in the same run,
  until something is promoted into it.
- Transitions with no changes skip the check.

#### Rolling Back a Promotion

Treat a promotion rollback as a new, auditable Git change: revert the source
configuration commit, then run the same forward promotion again.

```bash
git revert <promotion-commit>
npm run promote -- --pipeline release --from dev --to staging --apply
```

This is distinct from `npm run rollback`, which restores a single org from a
local pre-deploy snapshot. Because promotion uses the pipeline's scoped mirror
boundary, reverting a resource creation also removes that promoted resource
from the destination without touching unrelated destination resources.

---

## PR Checks: simulations against your branch

`npm run check` runs your simulation suites against the **PR branch's own
files** — prompts, tools, handoffs, structured outputs — without deploying
anything. Each check target (an assistant or a squad) is built from
`resources/<org>/` and sent inline, with its scenarios and judges, in one
simulation run. Nothing is created in the org, so there is nothing to clean
up, and it works with a single org.

### 1. Write tests

Under `resources/<org>/simulations/`:

- `personalities/calm-caller.yml` (or reference a stock personality by ID)
- `scenarios/books-appointment.yml` — instructions, at least one **required
  text judge**, and `toolMocks` for the tools this scenario calls:

  ```yaml
  name: Books an appointment
  instructions: >
    You are John Smith calling to book a cleaning next Tuesday. End the call once it's confirmed.
  evaluations:
    - structuredOutput:
        name: booking-confirmed
        type: ai
        schema: { type: boolean, description: "Did the assistant confirm a booking time?" }
      comparator: "="
      value: true
      required: true
  toolMocks:
    - toolName: book_appointment
      result: '{"success": true, "time": "Tuesday 10:00"}'
  ```

  Judges may also reference a file with `structuredOutputId: <name>`. Over
  chat, yes/no judges (`=` with `value: true`) are the verified shape; don't
  use `hooks` or `messages-with-audio` judges with chat.
- `tests/books-appointment-calm.yml`: `{ name, personalityId: calm-caller, scenarioId: books-appointment }`
- `suites/core.yml`: `{ name: Core, simulationIds: [books-appointment-calm] }`

### 2. Configure the check

```bash
cp vapi-checks.example.yml vapi-checks.yml
```

```yaml
version: 1
checks:
  core:
    org: my-org
    targets: [squads/main-squad]
    suites: [core]
```

### 3. Dry run locally (no key, nothing sent)

```bash
npm run check -- core --dry-run --print-payload
```

`tmp/check-payloads/` shows exactly what would be sent. The build fails,
naming the field, when it can't make a safe, faithful payload:

| Problem | Fix |
| --- | --- |
| A tool that can't be mocked (SMS, MCP, code, integrations), or an `apiRequest` with no `name` | Remove it, name the `apiRequest`, or set `toolMocks: off` with a dedicated CI org |
| A tool referenced by ID, or a `toolRefs` pin, with no file in `resources/<org>/tools/` | Pull the tool into gitops |
| A handoff leaving the squad (`dynamic`, another squad, a non-member), or an assistant target that hands off | Make the target a squad of those assistants |
| A legacy `assistantDestinations` entry naming an assistant by ID | Convert it to a handoff tool |
| Tools by ID inside `assistantOverrides`, `membersOverrides` or `targetOverrides` | Put them inline in `tools:append` |
| Tools outside `model.tools` / `model.toolIds` (`model.functions`, reasoner skills, a recording-consent decline tool) | Move them to `model.tools` |
| `model.knowledgeBaseId`, a custom knowledge base, or a knowledge base / `query` tool when the check runs in another org | Use a knowledge-base tool in the same org |
| Personality tools beyond `endCall`-style ones | Keep the personality free of side-effect tools |
| Two tools with the same type and name on one assistant | Rename one |
| Audio judges, scenario hooks, or no required text judge over chat | Add a text judge, or use `transport: voice` |

Two things to know:

- **Transfers never happen.** Every `transferCall` becomes a mocked
  function, so a scenario that needs a real transfer fails rather than
  falsely passing.
- **Handoff names.** The check warns when a prompt mentions an
  auto-generated `handoff_to_…` name — those differ between inline and
  deployed assistants. Give that handoff an explicit `function.name`.

### 4. Live run locally

```bash
npm run check -- core
```

Uses `.env.<org>`, prints the run link, and exits 0 passed, 1 failed, 2
config or build error, 3 incomplete. It uses simulation minutes.

### 5. Turn on the PR workflow

In GitHub → Settings → Secrets and variables → Actions:

- Secret `VAPI_PRIVATE_API_KEY` (single org), or `VAPI_CHECK_TOKENS` =
  `{"my-org":"<private key>"}` (several orgs, or a CI org).
- Variable `VAPI_CHECKS_ENABLED=true`.

`.github/workflows/vapi-checks.yml` then runs every affected check on each
PR push. It asks for `statuses: write` only to post the direct links.

### 6. What a PR shows

- `Vapi Evals`, plus `Vapi Evals / <check> / <target>` per target. **Details**
  opens the run in Vapi.
- A job summary: per-target result, failing judges with expected vs actual,
  and any "unmocked tool called" notices. No PR comments.
- PRs that touch neither a check's org, its state, `vapi-checks.yml`,
  `promotion.yml`, the engine (`src/**`, `package*.json`), nor the check's
  own `paths` skip it, and `Vapi Evals` posts success.
- A newer push cancels the older run.

### 7. Make it required (after a burn-in)

Require the **commit status `Vapi Evals`** in branch protection — not the
`vapi-checks` job (fork dry runs succeed) and not the per-target statuses
(PRs that don't touch a check never get them).

- **Fork PRs** run a dry run without secrets and can't post statuses (the
  token is read-only), so a required `Vapi Evals` blocks them.
- **Dependabot PRs** that change `package*.json` post `error`.
- **To unblock either**, a maintainer runs Actions → Vapi checks → Run
  workflow on the PR's branch with `check` blank (push a fork's branch into
  the repository first). A later PR event on the same commit resets the
  status, so dispatch again after that. Running one named check by hand
  never changes `Vapi Evals`.

### Gate promotion on a check (optional)

Multi-org repos can require a check to pass in an org before anything is
promoted out of it: set `orgs.<org>.check: <name>` in `promotion.yml` (see
[Check before promoting](#check-before-promoting-optional)).

### Dedicated CI org (optional; recommended with `toolMocks: off`)

1. `npm run setup -- my-ci-org --resources none`.
2. Create the credentials your agents need there, with the same names as
   production.
3. `npm run pull -- my-ci-org --bootstrap --bindings-only`, then commit
   `.vapi-state.my-ci-org.json` so the state knows those credentials. The PR
   workflow refreshes bindings on every live run.
4. Add `runOrg: my-ci-org` (and `baseUrl` for EU) to the check, and
   optionally `bindings:` (same shape as `promotion.yml`). Phone numbers are
   omitted by default.
5. Put only the CI org's key in `VAPI_CHECK_TOKENS`.

### Cost and safety

- Every affected push starts paid runs; chat transport is the default.
- Tool calls get their scenario mock or an error, and every assistant and
  function-tool server points at `https://vapi-gitops-ci.invalid`.
- Still real in the run org: custom LLM, voice and transcriber servers see
  the conversation; org-wide and assistant monitors run; `observabilityPlan`
  exports transcripts; prompts are stored with the run. A CI org avoids all
  of these.
- `.ts` resource files execute during the check, with the workflow's secrets
  on same-repository PRs.

---

## How to Use This Repo

1. **Run `npm run setup`** to configure your first org (or `npm run setup -- <org>` without a terminal)
2. **Edit resources** in `resources/<org>/` (`.md` assistants, `.yml` tools/squads/etc.)
3. **Validate** with `npm run validate -- <org>`
4. **Deploy** with `npm run apply -- <org>` (pull → merge → push)

Use:

- `apply` for deploys — the default; safe against dashboard edits made since your last pull
- `pull` when Vapi might have changed and you only want to sync down
- `push` only right after a `pull`, when nothing else has touched the dashboard (see [When to use raw `push`](#when-to-use-raw-push-instead-of-apply))

### Bootstrap State Sync

Use bootstrap pull when you need the latest platform IDs and org-local bindings without downloading all remote resources:

```bash
npm run pull -- my-org --bootstrap
```

This refreshes `.vapi-state.<org>.json`, credential mappings, and the generated credential/phone-number block in `.env.<org>` while leaving `resources/<org>/` untouched. Setup and ordinary pulls perform the same binding refresh. If you skip this step, `push` will automatically run it when it detects empty or stale state.

### Pulling a Single Resource By UUID

```bash
npm run pull -- my-org --type squads --id <squad-uuid>
```

`--id` must be paired with exactly one resource type.

### Pulling Without Losing Local Work

By default, `pull` preserves any files you've locally modified or deleted:

```bash
npm run pull -- my-org
# ⏭️  my-assistant (locally changed, skipping)
# ✨  new-tool -> resources/my-org/tools/new-tool.yml
```

Detection works in three layers, so it covers both day-to-day and fresh-clone
workflows:

1. **Content baseline (primary)** — each resource's last-seen platform hash
   lives in the per-developer `.vapi-state-hash/<org>/<uuid>` store
   (gitignored). Comparing local / baseline / dashboard hashes classifies
   every resource as clean, local-ahead (preserved ⬆️), dashboard-ahead
   (synced down ⬇️ — local was unchanged, nothing to lose), or both-diverged
   (gated behind `--resolve=ours|theirs|fail|defer`). See
   `docs/learnings/sync-behavior.md` for the full matrix.
2. **Git-tracked changes** — when no baseline exists yet, files that show up
   in `git status` (modified, deleted, or individually untracked) are
   preserved.
3. **mtime fallback** — if git can't help (no commits yet, the resource tree
   isn't tracked at all, or git just had nothing to say), files that are
   newer than `.vapi-state.<org>.json` are still preserved. This is the safety
   net for the "fresh clone, edit a file, run pull again" case.

Interactive `npm run pull` defaults to local-first too — it asks
`Overwrite locally modified files?` (default `No`) before forwarding the
pull. Pass `--force` directly (or answer `Yes` to that prompt) to overwrite
everything with the platform version.

### Selective Push

Push only specific resources instead of everything:

```bash
# By resource type
npm run push -- my-org assistants
npm run push -- my-org tools

# By specific file (long form)
npm run push -- my-org resources/my-org/assistants/my-assistant.md

# By specific file (short form — folder/filename)
npm run push -- my-org assistants/my-assistant.md
npm run push -- my-org simulations/personalities/skeptical-sam.yml

# Multiple files
npm run push -- my-org resources/my-org/assistants/a.md resources/my-org/tools/b.yml
```

> A bare resource id like `npm run push -- my-org my-assistant` (no folder,
> no extension) is **rejected explicitly**. The CLI prints
> `Unrecognized argument: my-assistant` and exits with a non-zero code rather
> than silently falling through to a full apply. Pass either a type
> (`assistants`) or a path (`assistants/my-assistant.md`).

### Auto-Dependency Resolution

When pushing a single squad or assistant, missing dependencies (tools, structured outputs, etc.) are automatically created first:

```
Squad push
  └─ missing assistants? → auto-create them first
       └─ missing tools / structured outputs? → auto-create those first
  └─ all references resolved → create the squad ✓
```

---

## File Formats

Every snippet below is a file from [`examples/starter/`](examples/starter/), a
small dental-clinic front desk with two assistants, tools, a handoff and a
simulation suite. CI checks that each snippet matches its file and that the
example passes `validate`, so you can copy from here safely.

A resource's ID is its path under the type folder, without the extension
(`tools/lookup-patient.yml` is `lookup-patient`). Reference other resources
by that ID, never by UUID: the engine resolves IDs to UUIDs per org.

### Assistants (`.md` or `.yml`)

Markdown with YAML frontmatter: the frontmatter is the assistant config and the
body is its system prompt.

```markdown
<!-- examples/starter/resources/starter/assistants/receptionist.md -->
---
name: Receptionist
firstMessage: Thanks for calling Bright Smile Dental. How can I help?
model:
  provider: openai
  model: gpt-4.1
  temperature: 0.3
  toolIds:
    - lookup-patient
    - handoff-to-scheduler
  tools:
    - type: endCall
voice:
  provider: 11labs
  voiceId: sarah
artifactPlan:
  structuredOutputIds:
    - call-summary
---

# Identity

You are the receptionist for Bright Smile Dental, 123 Main St. The clinic is
open Monday to Friday, 8am to 5pm.

# Flow

1. Ask for the caller's phone number and call `lookup_patient` with it.
2. If they want to book, change or check an appointment, hand off to the
   Scheduler with `handoff_to_scheduler`. Don't book anything yourself.
3. Answer general questions (hours, address) briefly yourself.
```

### Tools (`.yml`)

```yaml
# examples/starter/resources/starter/tools/lookup-patient.yml
type: function
function:
  name: lookup_patient
  description: Look up the caller's patient record by phone number.
  parameters:
    type: object
    properties:
      phone:
        type: string
        description: The caller's phone number
    required:
      - phone
server:
  url: https://example.com/vapi/lookup-patient
```

Handoffs between assistants are tools too. Give each one an explicit
`function.name` if your prompts mention it by name:

```yaml
# examples/starter/resources/starter/tools/handoff-to-scheduler.yml
type: handoff
function:
  name: handoff_to_scheduler
destinations:
  - type: assistant
    assistantId: scheduler
    description: Books, changes and checks appointments.
```

### Structured Outputs (`.yml`)

```yaml
# examples/starter/resources/starter/structuredOutputs/call-summary.yml
name: call-summary
type: ai
description: Summarizes the call for the front-desk log.
schema:
  type: object
  properties:
    summary:
      type: string
    booked:
      type: boolean
```

### Squads (`.yml`)

```yaml
# examples/starter/resources/starter/squads/front-desk.yml
name: Front Desk
members:
  - assistantId: receptionist
  - assistantId: scheduler
```

Members hand off to each other through handoff tools on the assistants, as
above. Prefer them over the legacy `assistantDestinations` field.

### Evals (`.yml`)

An eval file is the body of the [Evals API](https://docs.vapi.ai/api-reference/evals)
create request, written as YAML.

### Simulations

**Personality** (`simulations/personalities/`): the simulated caller, as an
assistant config.

```yaml
# examples/starter/resources/starter/simulations/personalities/calm-caller.yml
name: Calm caller
assistant:
  model:
    provider: openai
    model: gpt-4.1-mini
    messages:
      - role: system
        content: >
          You are a patient calling a dental clinic. Follow your scenario,
          answer questions briefly, and don't invent details.
```

**Scenario** (`simulations/scenarios/`): what the caller does, how the call is
judged (at least one evaluation), and mock results for the tools it calls.

```yaml
# examples/starter/resources/starter/simulations/scenarios/books-cleaning.yml
name: Books a cleaning
instructions: >
  You are Jordan Lee, phone 206-555-0142, an existing patient. Book a teeth
  cleaning for next Tuesday morning and accept the first slot offered. Once
  the booking is confirmed, say thanks and goodbye.
evaluations:
  - structuredOutputId: booking-confirmed
    comparator: "="
    value: true
    required: true
toolMocks:
  - toolName: lookup_patient
    result: '{"found": true, "patientId": "P-1001"}'
  - toolName: book_appointment
    result: '{"success": true, "date": "next Tuesday", "time": "09:00"}'
```

**Simulation** (`simulations/tests/`): a personality paired with a scenario.

```yaml
# examples/starter/resources/starter/simulations/tests/books-cleaning-calm.yml
name: Books a cleaning (calm caller)
personalityId: calm-caller
scenarioId: books-cleaning
```

**Simulation Suite** (`simulations/suites/`):

```yaml
# examples/starter/resources/starter/simulations/suites/core.yml
name: Core
simulationIds:
  - books-cleaning-calm
```

### TypeScript resources (`.ts`)

Any resource can also be a `.ts` file whose default export is the resource
object, useful for generating config. It is executed when loaded, so treat
`.ts` resources like code in review.

---

## How the Engine Works

### Sync Workflow

```
pull (default)     pull --force        push
─────────────      ─────────────       ─────────────
Download from      Download from       Upload local
platform, skip     platform, overwrite files to
locally changed    everything          platform
files
```

**`pull`** — downloads platform state. Detects locally modified files and skips them (your work is preserved). Use `--force` to overwrite everything.

**`push`** — reads local files and syncs them to the platform. Handles creates, updates, and deletions.

**`apply`** — runs `pull` then `push` in sequence.

### Processing Order

**Push** (dependency order): Tools → Structured Outputs → Assistants → Squads → Personalities → Scenarios → Simulations → Simulation Suites → Evals

**Delete** (reverse dependency order): Evals → Simulation Suites → Simulations → ... → Tools

### Reference Resolution

Resource IDs (filenames without extension) are automatically resolved to Vapi UUIDs:

```yaml
# You write:
toolIds:
  - my-tool

# Engine sends to API:
toolIds:
  - "uuid-1234-5678-abcd"
```

### Credential Management

Credentials are managed automatically through the state file. No secrets in resource files or git.

1. **Pull** fetches credentials from Vapi and stores `name → UUID` in the state file
2. Resource files use human-readable credential names
3. **Push** resolves names back to UUIDs before sending to the API

Setup and pull also refresh a marked block in the gitignored `.env.<org>` file:

```dotenv
# BEGIN VAPI MANAGED BINDINGS
VAPI_CREDENTIAL_MY_SERVER_CREDENTIAL=<org-specific-uuid>
VAPI_PHONE_NUMBER_SUPPORT_LINE=<org-specific-uuid>
# END VAPI MANAGED BINDINGS
```

Only IDs are exported. Credentials and phone numbers are never provisioned or
copied between orgs. Phone numbers must have a dashboard name; unnamed or
duplicate-name matches are omitted with a warning. Values maintained outside
the marked block are preserved and take precedence.

```yaml
# Resource file (environment-agnostic)
server:
  credentialId: my-server-credential

# State file (environment-specific)
# "credentials": { "my-server-credential": { "uuid": "2f6db611-ad08-4099-8bd8-74db37b0a07e" } }
```

### State File

Tracks resource ID ↔ Vapi UUID mappings per org:

```json
{
  "assistants": { "my-assistant": { "uuid": "9c0f3f42-…" } },
  "credentials": { "my-cred": { "uuid": "2f6db611-…" } },
  "squads": { "my-squad": { "uuid": "51a9e1c7-…" } },
  "tools": { "my-tool": { "uuid": "d4b8a2e0-…" } }
}
```

Every resource type has a section. Keys are sorted, so diffs stay readable.

---

## Project Structure

```
vapi-gitops/
├── docs/
│   ├── Vapi Prompt Optimization Guide.md
│   ├── changelog.md
│   └── learnings/                      # Gotchas, recipes, troubleshooting per area
│       ├── assistants.md
│       ├── tools.md
│       ├── squads.md
│       ├── simulations.md
│       └── ...
├── src/
│   ├── setup.ts               # Setup wizard (interactive) + non-interactive setup
│   ├── setup-args.ts          # `npm run setup` argument parsing
│   ├── interactive.ts          # Interactive pull/push/apply/call/cleanup flows
│   ├── searchableCheckbox.ts   # Custom multi-select prompt component
│   ├── pull.ts                 # Pull platform state
│   ├── push.ts                 # Push local state to platform
│   ├── apply.ts                # Orchestrator: pull → merge → push
│   ├── call.ts                 # WebSocket call script
│   ├── cleanup.ts              # Orphan cleanup
│   ├── pull-cmd.ts             # Entry point: interactive or direct pull
│   ├── push-cmd.ts             # Entry point: interactive or direct push
│   ├── apply-cmd.ts            # Entry point: interactive or direct apply
│   ├── call-cmd.ts             # Entry point: interactive or direct call
│   ├── cleanup-cmd.ts          # Entry point: interactive or direct cleanup
│   ├── types.ts                # TypeScript interfaces
│   ├── config.ts               # Environment & configuration
│   ├── api.ts                  # Vapi HTTP client
│   ├── state.ts                # State file management
│   ├── resources.ts            # Resource loading (YAML, MD, TS)
│   ├── resolver.ts             # Reference resolution
│   ├── credentials.ts          # Credential resolution (name ↔ UUID)
│   ├── delete.ts               # Deletion & orphan checks
│   └── check-cmd.ts            # Entry point: PR simulation checks (check-*.ts)
├── resources/
│   └── <org>/                  # One directory per configured org
│       ├── assistants/
│       ├── tools/
│       ├── squads/
│       ├── structuredOutputs/
│       ├── evals/
│       └── simulations/
│           ├── personalities/
│           ├── scenarios/
│           ├── tests/
│           └── suites/
├── tests/
│   ├── credentials.test.ts     # Credential walker scoping (P0-1 regression suite)
│   ├── clean-resource.test.ts  # null-preservation in pull (P0-3 regression suite)
│   ├── path-matching.test.ts   # Short-form path matching (P0-7 regression suite)
│   ├── cleanup-safety.test.ts  # --confirm + empty-state gates (P0-4 regression suite)
│   └── cli-arg-parsing.test.ts # Bare-id refusal, --confirm pass-through (P0-7)
├── vapi-checks.example.yml     # Copy to vapi-checks.yml for PR simulation checks
├── .env.<org>                  # Private API key per org (gitignored)
└── .vapi-state.<org>.json      # State file per org
```

---

## Configuration

### Environment Variables

| Variable        | Required | Description                                      |
| --------------- | -------- | ------------------------------------------------ |
| `VAPI_PRIVATE_API_KEY`  | ✅       | Vapi private API key from [Private API Keys](https://dashboard.vapi.ai/org/api-keys). The legacy name `VAPI_TOKEN` is still accepted. |
| `VAPI_BASE_URL` | ❌       | API base URL (defaults to `https://api.vapi.ai`) |

These are stored in `.env.<org>` files, one per configured organization.

---

## Troubleshooting

### "Reference not found" warnings

The referenced resource doesn't exist. Check:

1. File exists in correct folder
2. Filename matches exactly (case-sensitive)
3. Using filename without extension
4. For nested resources, use full path (`folder/resource`)

### "Cannot delete resource - still referenced"

1. Find which resources reference it (shown in error)
2. Remove the references
3. Push again
4. Then delete the resource file

### Resource not updating

Check the state file has correct UUID:

1. Open `.vapi-state.<org>.json`
2. Find the resource entry
3. If incorrect, delete entry and re-run push

### "Credential with ID not found" errors

The credential UUID doesn't exist in the target org. Fix:

1. Run `npm run pull -- <org>` to fetch credentials into the state file
2. If the credential doesn't exist, create it in the Vapi dashboard with the same name
3. Pull again — the mapping will be auto-populated

### "property X should not exist" API errors

Some properties can't be updated after creation. Add them to `UPDATE_EXCLUDED_KEYS` in `src/config.ts`.

### "Refusing to run destructive cleanup" errors

`npm run cleanup` is intentionally double-gated for destructive runs:

- `--force` alone is not enough — you also have to name the org with
  `--confirm <org>`. This catches the common mistake of copy-pasting `--force`
  from another command where it had a different meaning.
- An empty state file (zero tracked resources) is refused even with both
  flags. This prevents a fresh clone or a corrupted state from being misread
  as "all remote resources are orphaned" and wiping the org.

```bash
# Wrong — refused
npm run cleanup -- my-org --force

# Right — destructive run
npm run cleanup -- my-org --force --confirm my-org

# Bootstrapping into an empty state? Pull first.
npm run pull -- my-org --bootstrap
```

The interactive `npm run cleanup` flow handles both gates for you (it shows
the dry-run preview, asks you to confirm, and forwards `--force --confirm
<org>` automatically when you say yes).

### "Unrecognized argument" / push appears to do nothing

If you typed `npm run push -- my-org foo` (a bare resource id with no folder
or extension), the CLI now refuses with `Unrecognized argument: foo` rather
than silently running a full apply. Pass either:

- a resource type — `npm run push -- my-org assistants`, or
- a path — `npm run push -- my-org assistants/foo.yml` (short form)
  or `npm run push -- my-org resources/my-org/assistants/foo.yml` (long form).

---

## API Reference

- [Assistants API](https://docs.vapi.ai/api-reference/assistants/create)
- [Tools API](https://docs.vapi.ai/api-reference/tools/create)
- [Structured Outputs API](https://docs.vapi.ai/api-reference/structured-outputs/structured-output-controller-create)
- [Squads API](https://docs.vapi.ai/api-reference/squads/create)
- [Evals API](https://docs.vapi.ai/api-reference/evals)
