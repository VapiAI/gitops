# state/

The engine writes everything in this folder. Don't edit or delete these files by hand. Commit them whenever a command changes them.

| Path | What it holds | In git |
| --- | --- | --- |
| `state/<org>/state.json` | Which Vapi resource (UUID) each file under `resources/<org>/` is. | Yes |
| `state/<org>/org.json` | The Vapi org that `resources/<org>/` belongs to. A command run with another org's key stops before it reads or changes anything. | Yes |
| `state/<org>/credential-providers.json` | The provider of each saved credential, by name, with no secret. The [credential-pin check](../docs/guides/credential-pins.md) reads it. | Yes |
| `state/<org>/local/baselines/` | The last version of each resource this machine saw on the platform, used to notice dashboard edits. | No |
| `state/<org>/local/snapshots/` | A copy of each resource taken before a push, for `npm run rollback`. | No |
| `state/commit-step.json` | Only in a repository whose own pipeline commits state in a way the engine can't read. It is that repository's word, given with `npm run migrate -- --commit-step-stages-state`, that the pipeline stages this folder. | Yes |

## What happens if a file goes missing

- **`state.json`**: the engine no longer knows which resources already exist, so the next push creates every one of them again as a duplicate. Restore the file from git (`git checkout -- state/<org>/state.json`). Never rebuild it by hand.
- **`org.json`**: the next command pins the folder again to whichever org its key belongs to, so the protection against a wrong key is gone until then. Restore it from git.
- **`credential-providers.json`**: `validate` can't check `credentialIds` lists and says so. The next pull writes the file again.
- **`commit-step.json`**: nothing is lost. A CI run under that pipeline stops before it changes anything and says how to put the file back.
- **`local/`**: nothing breaks. The next pull records new baselines. Snapshots taken so far are gone, so there is nothing to roll back to until the next push.

## What is yours to edit

Everything under `resources/<org>/`, including `resources/<org>/.vapi-ignore` and `resources/<org>/.vapi-policy.yml`, is hand-written and yours. This folder is the engine's.

## Repositories created before this folder existed

The same files used to sit elsewhere: `.vapi-state.<org>.json` and `.vapi-state.<org>.snapshots/` at the repository root, `.vapi-state-hash/<org>/`, and `resources/<org>/.vapi-org.json`. The engine keeps reading and writing them there, on your machine and in CI, for as long as you leave them.

Only `npm run migrate` moves them here. Before it moves anything it says what the step that commits state after a run has to stage, and it moves nothing while it can't see that step stage this folder, unless you tell it yours does. Commit the removal of the old files together with the new folder. See [Upgrading from an older version](../docs/guides/commands.md#upgrading-from-an-older-version).
