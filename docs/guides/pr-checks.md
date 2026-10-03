# PR Checks: simulations against your branch

`npm run check` runs your simulation suites against the **PR branch's own
files** — prompts, tools, handoffs, structured outputs — without deploying
anything. Each check target (an assistant or a squad) is built from
`resources/<org>/` and sent inline, with its scenarios and judges, in one
simulation run. Nothing is created in the org, so there is nothing to clean
up, and it works with a single org.

## 1. Write tests

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

## 2. Configure the check

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

## 3. Dry run locally (no key, nothing sent)

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

## 4. Live run locally

```bash
npm run check -- core
```

Uses `.env.<org>`, prints the run link, and exits 0 passed, 1 failed, 2
config or build error, 3 incomplete. It uses simulation minutes.

## 5. Turn on the PR workflow

In GitHub → Settings → Secrets and variables → Actions:

- Secret `VAPI_PRIVATE_API_KEY` (single org), or `VAPI_CHECK_TOKENS` =
  `{"my-org":"<private key>"}` (several orgs, or a CI org).
- Variable `VAPI_CHECKS_ENABLED=true`.

`.github/workflows/vapi-checks.yml` then runs every affected check on each
PR push. It asks for `statuses: write` only to post the direct links.

## 6. What a PR shows

- `Vapi Evals`, plus `Vapi Evals / <check> / <target>` per target. **Details**
  opens the run in Vapi.
- A job summary: per-target result, failing judges with expected vs actual,
  and any "unmocked tool called" notices. No PR comments.
- PRs that touch neither a check's org, its state, `vapi-checks.yml`,
  `promotion.yml`, the engine (`src/**`, `package*.json`), nor the check's
  own `paths` skip it, and `Vapi Evals` posts success.
- A newer push cancels the older run.
- Separately, the **Validate resources** check (in `ci.yml`) runs
  `npm run validate` on every org, including resources no check targets.
  It's offline and runs whether or not PR checks are turned on.

## 7. Make it required (after a burn-in)

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

## Gate promotion on a check (optional)

Multi-org repos can require a check to pass in an org before anything is
promoted out of it: set `orgs.<org>.check: <name>` in `promotion.yml` (see
[Check before promoting](promotion.md#check-before-promoting-optional)).

## Dedicated CI org (optional; recommended with `toolMocks: off`)

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

## Cost and safety

- Every affected push starts paid runs; chat transport is the default.
- Tool calls get their scenario mock or an error, and every assistant and
  function-tool server points at `https://vapi-gitops-ci.invalid`.
- Still real in the run org: custom LLM, voice and transcriber servers see
  the conversation; org-wide and assistant monitors run; `observabilityPlan`
  exports transcripts; prompts are stored with the run. A CI org avoids all
  of these.
- `.ts` resource files execute during the check, with the workflow's secrets
  on same-repository PRs.
