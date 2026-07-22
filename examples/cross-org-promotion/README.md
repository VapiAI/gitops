# Dummy Cross-Org Promotion Example

> **EXAMPLE ONLY.** Every API token, UUID, endpoint, and org in this directory
> is fake. Nothing here connects to Vapi, and the GitOps engine does not load
> resources from `examples/`.

This fixture shows the shape of a linear `example-dev` → `example-staging` →
`example-production` setup. Each org contains the same logical resources:

- `customer-lookup`: a function tool that uses the logical credential alias
  `crm-api`
- `support-assistant`: an assistant that references `customer-lookup`

The example state files intentionally assign different UUIDs to the same
logical resources in each org. They are reference material only. Never copy
them into the repository root or use them with a real Vapi organization.

## What the promotion engine does

The engine resolves tools, structured outputs, assistants, and credentials
through each org's own `.vapi-state.<org>.json`. `npm run promote` mirrors only
the resource patterns reviewed in `promotion.yml`, includes referenced managed
dependencies, and lets the destination push mint or reuse that org's UUIDs.
Source-org managed UUIDs are never copied as destination references.

## Try it with disposable Vapi orgs

Use real disposable orgs, not the fake IDs in this directory.

1. Copy each example resource directory into the live `resources/` directory:

   ```bash
   cp -R examples/cross-org-promotion/resources/example-dev resources/
   cp -R examples/cross-org-promotion/resources/example-staging resources/
   cp -R examples/cross-org-promotion/resources/example-production resources/
   ```

2. Copy the matching environment templates to the repository root and replace
   each fake token with a private API key from its disposable org:

   ```bash
   cp examples/cross-org-promotion/env/example-dev.env .env.example-dev
   cp examples/cross-org-promotion/env/example-staging.env .env.example-staging
   cp examples/cross-org-promotion/env/example-production.env .env.example-production
   ```

3. In each disposable org, create a server credential named `CRM API` and name
   an existing phone number `Support Line`. Run a bootstrap pull so GitOps
   discovers both org-local bindings:

   ```bash
   npm run pull -- example-dev --bootstrap
   npm run pull -- example-staging --bootstrap
   npm run pull -- example-production --bootstrap
   ```

4. Validate all three orgs without making network changes:

   ```bash
   npm run validate -- example-dev
   npm run validate -- example-staging
   npm run validate -- example-production
   ```

5. Copy `promotion.example.yml` to `promotion.yml`, keep the three example orgs,
   and set the resource patterns to `assistants/support-*` and
   `tools/customer-*`.

6. Review the promotion plan. It does not write files or call Vapi:

   ```bash
   npm run promote -- --pipeline release --from example-dev --to example-staging
   ```

7. After reviewing the plan, apply it. The command refreshes bindings, mirrors
   the selected files, and uses the existing guarded apply path for creation,
   modification, and deletion:

   ```bash
   npm run promote -- --pipeline release --from example-dev --to example-staging --apply
   ```

## Verify the mapping behavior

After the first successful apply, compare the three generated state files:

```bash
node -e 'for (const org of ["example-dev", "example-staging", "example-production"]) { const s = require(`./.vapi-state.${org}.json`); console.log(org, { credential: s.credentials["crm-api"].uuid, tool: s.tools["customer-lookup"].uuid, assistant: s.assistants["support-assistant"].uuid }); }'
```

The aliases should be identical while every org's physical IDs are different.
No UUID should appear in the resource YAML or Markdown.

## Promote and roll back through Git

To test an update, change and apply the dev assistant, commit the change, then
run the same promotion command. The destination keeps its existing UUID while
the changed content is patched.

Rollback is a forward Git operation: revert the configuration commit and apply
the same promotion again. If the revert removes a newly created source file,
the promotion's scoped mirror removes the matching destination file and the
existing `apply --force` path deletes only that state-tracked destination
resource.

## Credentials and phone numbers

`crm-api` is a stable logical alias. The initial alias can be generated from a
credential named `CRM API`, but the state file preserves the alias after that.
The actual credential and secret remain unique to each org. The example env
files also show the generated binding variable:

```dotenv
VAPI_CREDENTIAL_CRM_API=<existing-credential-id-in-this-org>
```

Phone numbers are not represented as GitOps resource files or in the state
schema. Pull/setup export a stable alias such as `support-line` for selecting
an existing target-org phone-number ID:

```dotenv
VAPI_PHONE_NUMBER_SUPPORT_LINE=<existing-phone-number-id-in-this-org>
```

These variables model credentials and phone numbers as **org-local bindings**,
not managed resources. Credential references continue to resolve through the
org's state map; the generated variables are also available to promotion
workflows. GitOps may bind or omit an existing resource, but it never copies a
credential secret or provisions a phone number.

### Automatic binding population

Every setup and pull safely refreshes these IDs without copying secrets or
provisioning resources:

1. Credentials reuse their stable state aliases; named phone numbers use their
   dashboard names on first discovery.
2. A previously generated alias is preserved by UUID even if its dashboard
   name changes.
3. The marked block in `.env.<org>` is replaced while `VAPI_TOKEN`, custom
   settings, and manual bindings outside the block are preserved.
4. Unnamed phone numbers and ambiguous duplicate names are omitted with a
   warning instead of being guessed.

The block contains identifiers only. Credential secret material is never
returned by the list API or written to disk.
