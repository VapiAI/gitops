# Troubleshooting

## "Reference not found" warnings

The referenced resource doesn't exist. Check:

1. File exists in correct folder
2. Filename matches exactly (case-sensitive)
3. Using filename without extension
4. For nested resources, use full path (`folder/resource`)

## "Cannot delete resource - still referenced"

1. Find which resources reference it (shown in error)
2. Remove the references
3. Push again
4. Then delete the resource file

## Resource not updating

Check the state file has correct UUID:

1. Open `.vapi-state.<org>.json`
2. Find the resource entry
3. If incorrect, delete entry and re-run push

## "Credential with ID not found" errors

The credential UUID doesn't exist in the target org. Fix:

1. Run `npm run pull -- <org>` to fetch credentials into the state file
2. If the credential doesn't exist, create it in the Vapi dashboard with the same name
3. Pull again — the mapping will be auto-populated

## "property X should not exist" API errors

Some properties can't be updated after creation. Add them to `UPDATE_EXCLUDED_KEYS` in `src/config.ts`.

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

## "Unrecognized argument" / push appears to do nothing

If you typed `npm run push -- my-org foo` (a bare resource id with no folder
or extension), the CLI now refuses with `Unrecognized argument: foo` rather
than silently running a full apply. Pass either:

- a resource type — `npm run push -- my-org assistants`, or
- a path — `npm run push -- my-org assistants/foo.yml` (short form)
  or `npm run push -- my-org resources/my-org/assistants/foo.yml` (long form).
