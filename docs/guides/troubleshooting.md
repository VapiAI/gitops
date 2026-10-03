# Troubleshooting

## "Reference not found" warnings

The referenced resource doesn't exist. Check:

1. File exists in correct folder
2. Filename matches exactly (case-sensitive)
3. Using filename without extension
4. For nested resources, use full path (`folder/resource`)

## "Cannot delete resource - still referenced"

1. Find which resources reference it (shown in the error)
2. Remove those references and deploy with `npm run apply -- <org>`
3. Then delete the resource file and deploy again

## Resource not updating

The file may be mapped to the wrong platform resource, or to one that no
longer exists.

Run `npm run audit -- <org>`. It reports state entries that point at a
missing resource, or several files that point at the same one, with a
suggested fix for each.

Don't delete a state entry by hand: the next deploy would treat the file as
new, and stop at the new-file check (or create a duplicate if the check is
bypassed).

## "Credential with ID not found" errors

The credential UUID doesn't exist in the target org. Fix:

1. Run `npm run pull -- <org>` to fetch credentials into the state file
2. If the credential doesn't exist, create it in the Vapi dashboard with the same name
3. Pull again — the mapping will be auto-populated

## "property X should not exist" API errors

Some properties can't be changed after a resource is created, so the API
rejects them on update. Please [open an issue](https://github.com/VapiAI/gitops/issues/new/choose)
with the resource type and property, so the engine stops sending it.

As a stopgap you can add the property to `UPDATE_EXCLUDED_KEYS` in
`src/config.ts`. That's an engine change, so expect to resolve it when you
next pull in updates.

## "Refusing to run destructive cleanup" errors

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

## "Unrecognized argument" errors

A bare resource ID (`npm run push -- my-org foo`, with no folder or
extension) is rejected with `Unrecognized argument: foo`, rather than
falling through to a full deploy. Pass either:

- a resource type — `npm run push -- my-org assistants`, or
- a path — `npm run push -- my-org assistants/foo.yml` (short form)
  or `npm run push -- my-org resources/my-org/assistants/foo.yml` (long form).

## "Validate resources" fails in CI

The check runs `npm run validate` for every org under `resources/`. The
job log names each failing org; run the same command locally to see its
findings:

```bash
npm run validate -- <org>
```

Each error names the file, field and rule. Plain `push` only warns about
these errors, so a repository that has been deploying with `push` can carry
some from before the check existed; they show up on the next pull request,
whatever it changes. Fix them in that PR or a separate one first. `apply`
refuses to deploy until they're fixed anyway.

A folder under `resources/` that isn't a valid org name (lowercase letters,
digits and hyphens) fails too. Rename it, or move it out of `resources/`.
