# Two fictional GP practices sharing one squad design

An example for `nhs-test`: two assistants, one standalone handoff tool and two squads.
Each squad appends its own inline transfer tool to both shared assistants.
The squads differ in name, `membersOverrides.variableValues` and literal transfer
numbers. Shared prompts and model/voice settings live
under `templates/`; nothing under `examples/` is automatically deployed.

This is not an NHS service or a medical triage system. Do not use real patient
information. Mailboxes are fictional and numbers are in Ofcom's London drama
range (+44 20 7946 0000–0999). The prompts prohibit telephone transfers; the
inline transfer tools demonstrate practice-specific destinations. The appointments
handoff is between assistants and can be tested later on an approved web call.

The low-cost configuration is OpenAI `gpt-4.1-mini`, `maxTokens: 400`, and the
Vapi `Elliot` voice, as used by the repository's promotion example. API acceptance,
provider availability, billing and voice behaviour still require live verification.

## Why transfer numbers are literal

The Vapi API rejects Liquid in transfer number destinations. In the Vapi source,
`libs/core/src/types/tool.types/transferCallTool.types.ts:1064–1087` requires
E.164 by default. Disabling `numberE164CheckEnabled` still enforces
`/^\+?[a-zA-Z0-9]+$/`, which rejects Liquid braces and underscores. Each squad
therefore defines an inline `transferCall` tool in `membersOverrides['tools:append']`
with literal E.164 numbers. The numbers also remain in `variableValues` for the
shared handover prompt; keep both representations in sync.

## Validate without connecting an org

In a separate scratch copy of the engine, copy this example's `resources/` and
`templates/` to that copy's root, then run:

```bash
VAPI_PRIVATE_API_KEY_NHS_TEST=validate-only npm run validate -- nhs-test --strict
```

To demonstrate `variable-undefined`, temporarily remove `practice_mailbox` from
`resources/nhs-test/squads/nhs-test-practice-b.yml`. Validation warns for practice-b's
two members, not practice-a. Restore it before deployment. Standalone assistants
are intentionally not checked for call-time variables.

## Existing production org: not an isolated namespace

`nhs-test` is a local folder name, not a new Vapi org. The API key chooses the
actual org. Prefixes reduce name collisions but are not access controls.
Do not use `setup --resources none` as a promise of empty state: it bootstraps
the whole org's remote resource mappings. Never use `--force`, `--bootstrap`,
`--overwrite`, cleanup or an unscoped apply for this experiment.

Before any approved write, recheck remote names (including tool `function.name`)
and slugified names for collisions, review the engine-generated state, and run
a file-scoped push with `--dry-run --strict`. New files normally stop at the
new-file gate; add `--allow-new-files` only after the owner confirms these exact
five files are intentionally new. Review every planned POST/PATCH/DELETE. Expect
five POSTs and zero PATCHes/DELETEs on a fresh deployment; stop otherwise.
If the handoff tool already exists, the required continuation gate is four POSTs,
zero PATCHes and zero DELETEs: stop if the engine would PATCH the existing tool.
Dry-run skips live dependency-name lookups, so it is not proof against adoption
of an existing remote resource during a later real push. Recheck the live
inventory immediately before an approved write, not just the dry-run output.

`.vapi-ignore` is a denylist, not a prefix allowlist: `!` negation is unsupported.
Unrelated resources can be explicitly opted out by their engine IDs. Do not
copy private inventories, org state, pins or credentials into this public example.
No org connection, phone number purchase, call or API write is part of this example.
