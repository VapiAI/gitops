# state/

The engine writes everything in this folder. Don't edit or delete these files by hand. Commit them whenever a command changes them.

| Path | What it holds | In git |
| --- | --- | --- |
| `state/<org>/state.json` | Which Vapi resource (UUID) each file under `resources/<org>/` is. | Yes |
| `state/<org>/org.json` | The Vapi org that `resources/<org>/` belongs to. A command run with another org's key stops before it reads or changes anything. | Yes |
| `state/<org>/local/baselines/` | The last version of each resource this machine saw on the platform, used to notice dashboard edits. | No |
| `state/<org>/local/snapshots/` | A copy of each resource taken before a push, for `npm run rollback`. | No |
| `state/commit-step.json` | Only in a repository whose own pipeline commits state in a way the engine can't read. It is that repository's word, given with `npm run migrate -- --commit-step-stages-state`, that the pipeline stages this folder. | Yes |

## What happens if a file goes missing

- **`state.json`**: the engine no longer knows which resources already exist, so the next push creates every one of them again as a duplicate. Restore the file from git (`git checkout -- state/<org>/state.json`). Never rebuild it by hand.
- **`org.json`**: the next command pins the folder again to whichever org its key belongs to, so the protection against a wrong key is gone until then. Restore it from git.
- **`commit-step.json`**: nothing is lost. A CI run under that pipeline stops before it changes anything and says how to put the file back.
- **`local/`**: nothing breaks. The next pull records new baselines. Snapshots taken so far are gone, so there is nothing to roll back to until the next push.

## What is yours to edit

Everything under `resources/<org>/`, including `resources/<org>/.vapi-ignore`, is hand-written and yours. This folder is the engine's.

## Repositories created before this folder existed

The same files used to sit elsewhere: `.vapi-state.<org>.json` and `.vapi-state.<org>.snapshots/` at the repository root, `.vapi-state-hash/<org>/`, and `resources/<org>/.vapi-org.json`. The engine still reads them there. The next `npm run pull`, `npm run push` or `npm run apply` on your machine moves them here and says so in one line. Commit the removal of the old file together with the new folder. `npm run migrate` moves every org at once.

A CI run never moves them, and no command does while the engine can't see that the step committing state after a run stages this folder. See [Upgrading from an older version](../docs/guides/commands.md#upgrading-from-an-older-version).
