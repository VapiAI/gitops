# Promoting resources across orgs

Copy `promotion.example.yml` to `promotion.yml` and define any number of orgs
in their allowed one-way order. Each pipeline also declares the resource
patterns it owns. Those patterns are a safety boundary: matching destination
files are mirrored, including deletions, while unrelated destination files are
left alone.

## One-time promotion setup

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

## GitHub Actions

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
[dummy multi-org example](../../examples/cross-org-promotion/README.md). Nothing under
`examples/` is loaded by the engine.

## Source-org and deletion boundary

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

See [sync behavior](../../docs/learnings/sync-behavior.md#cross-org-promotion-deletions)
for the exact lifecycle.

## Check before promoting (optional)

Gate an org on a [PR check](pr-checks.md):
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

## Rolling Back a Promotion

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
