# Running many locations from one set of prompts

You run the same voice agent for several locations: clinics, branches,
stores. Most of the wording is the same everywhere. A few things differ: the
location's name, a local rule, one setting.

When every assistant carries its own pasted copy of the shared wording, two
things go wrong:

- **The copies drift.** Someone fixes a sentence in one assistant and not in
  the others. Later nobody can say which version is the right one.
- **One edit means many files.** A new safety rule has to be pasted into
  every assistant at every location, and one gets missed.

[Blocks](blocks.md) fix both. The shared wording lives in one file. Each
assistant holds a one-line marker that pulls it in. You edit the one file,
and one command lists every assistant the edit reaches and pushes it to them.

This page is the path through that job from start to finish, with a small
example you can copy. [Blocks](blocks.md) stays the reference for the syntax
and the rules; this page links to it rather than repeating it. The output
shown here comes from a test run, not a live org: see
[How this page was checked](#how-this-page-was-checked).

## The example: two clinics

[`examples/blocks/`](../../examples/blocks/README.md) holds two clinics that
share one emergency paragraph and one voice:

| File | What it is |
| --- | --- |
| `templates/blocks/red-flags.md` | Wording both clinics share |
| `templates/config/voice.yml`, `templates/config/call-settings.yml` | Settings both clinics share |
| `resources/north-clinic/` | North Clinic: a Triage assistant, a Pharmacy assistant and a squad |
| `resources/south-clinic/` | South Clinic: the same three files, plus its own version of the emergency paragraph |

Here each clinic is its own Vapi org, so each has its own folder under
`resources/`. Blocks work the same way when your locations are several
assistants inside one org.

To follow along, copy the example into the root of your repository. These
commands expect that you have no `templates/` folder yet:

```bash
cp -R examples/blocks/templates templates
cp -R examples/blocks/resources/north-clinic resources/north-clinic
cp -R examples/blocks/resources/south-clinic resources/south-clinic
```

Two commands only read your files. Nothing is sent to Vapi:

```bash
VAPI_PRIVATE_API_KEY=validate-only npm run validate -- north-clinic
npm run sync-blocks
```

`validate` checks the files and ends with `✅ Validation passed.` It makes no
API call, but it stops if no key is set. For a folder that is not connected
to an org yet, the placeholder above is enough. Leave the prefix off once the
org is connected.

`sync-blocks` lists every file whose blocks have not been pushed yet. Before
the first deploy that is all of them:

```text
🧩 Blocks sync (dry run: nothing is changed)
north-clinic
  assistants/pharmacy.md (block changed: blocks/red-flags.md, config/voice.yml)
  assistants/triage.md (block changed: blocks/red-flags.md, config/voice.yml)
  squads/front-desk.yml (block changed: config/call-settings.yml, config/voice.yml)
south-clinic
  assistants/pharmacy.md (block changed: blocks/red-flags.md, config/voice.yml)
  assistants/triage.md (block changed: blocks/red-flags.md, config/voice.yml)
  squads/front-desk.yml (block changed: config/call-settings.yml, config/voice.yml)
6 resource(s) still run the old block text. To push them: npm run sync-blocks -- --apply
```

From here on, a step marked **changes a live org** creates or updates
assistants in Vapi. It needs the folder to be an org you have connected (see
the [quick start](../../README.md#3-connect-an-org)), so use your own org
names in place of `north-clinic` and `south-clinic`. Every other step only reads
files, or reads the org without changing it.

## 1. Move the shared wording into a block

A prompt block is a Markdown file under `templates/blocks/`. An assistant
pulls it in with a line that holds only the marker, `@include` and the
block's name. This is the middle of the example's Triage prompt:

```markdown
You are the triage assistant for {{practice_name}}. You find out what the
caller needs and pass them to the right assistant.

@include red-flags

# Flow
```

To move wording you already have pasted into several assistants:

1. Put the paragraph in `templates/blocks/<name>.md`.
2. In each assistant, delete the pasted paragraph and write
   `@include <name>` on a line of its own in its place.
3. Run `npm run validate -- <org>`.
4. Run `npm run pull -- <org>`. This reads the org. For a file whose finished
   prompt is the same as the live one, it prints:

   ```text
   🧩 reception (uses blocks, matches the dashboard — file left as written)
   ```

   That line tells you the move changed no wording. If a file you moved does
   not get that line, its finished prompt differs from the live one: compare
   your block with the paragraph you deleted before you deploy.
5. Deploy the file. **Changes a live org.**

   ```bash
   npm run apply -- north-clinic assistants/reception.md
   ```

   Until this push, `npm run sync-blocks` lists the file, because nothing
   records yet which block text it was pushed with. After it, the list is
   empty.
6. Commit the block, the assistant files and the `state/` folder.

In the test run, the prompt held by the API after step 5 was the same,
character for character, as before the move.

What differs per call stays a variable. The engine does not touch
`{{practice_name}}` inside a block; Vapi fills it on each call from the
squad's `variableValues`, which each clinic's squad file sets.

The marker has a few rules (alone on its line, system prompts only):
[Prompt blocks](blocks.md#prompt-blocks).

## 2. Move the shared settings into a config block

A config block is a YAML file under `templates/config/`. Any mapping pulls it
in with a `$include` key. Both example assistants take their voice this way:

```yaml
voice:
  $include: voice
```

Each clinic's squad takes its call settings from `call-settings` the same way,
and sets the clinic's name beside it.

Moving settings you already have works like moving wording: put the shared
keys in `templates/config/<name>.yml`, replace them in each file with
`$include: <name>`, then run steps 3 to 6 above. In the test run the voice
the API held was unchanged after the move.

The full rules are in [Config blocks](blocks.md#config-blocks).

## 3. Deploy for the first time

**Changes a live org.** The first deploy creates the assistants and the
squad. `apply` stops when it meets files it has never deployed, and lists
them:

```text
❌ Push refused: 3 file(s) on disk have no state-file UUID mapping for env "north-clinic".
…
Files without state entry:
  - resources/north-clinic/assistants/pharmacy.md
  - resources/north-clinic/assistants/triage.md
  - resources/north-clinic/squads/front-desk.yml
```

Read the list. When every file on it is meant to be new, confirm with the
flag (see
[Create new resources after the first deploy](workflows.md#create-new-resources-after-the-first-deploy)):

```bash
npm run apply -- north-clinic --allow-new-files
npm run apply -- south-clinic --allow-new-files
```

```text
   ⚠️  bypassing new-file gate: creating 3 new resource(s) on the dashboard
  ✨ Creating assistant: pharmacy
  ✨ Creating assistant: triage
  ✨ Creating squad: front-desk
…
✅ Apply complete! (Pull → Merge → Push)
```

Then commit what you copied and what the deploy recorded:

```bash
git add templates resources state
git commit -m "Add two clinics that share blocks"
```

`state/<org>/` is the engine's record of each org. One file in it,
`blocks.json`, records which block text each resource was last pushed with.
That record is how `sync-blocks` knows what a block edit has not reached
yet. Commit `state/` whenever a command changes it, and never edit it by
hand.

After the deploy, `npm run sync-blocks` prints
`✅ Every resource is in sync with its blocks.`

Vapi only ever receives the finished resource. In the test run, the prompt
the API held for North Clinic's Triage had the emergency paragraph where the
marker was, its voice was the two fields of `voice.yml`, and no `@include`
text reached the API.

## 4. Give one location something different

### Different wording: the location's own block

A location replaces a shared block by having a file of the same name under
its own folder, `resources/<org>/templates/blocks/`. South Clinic does this
with `resources/south-clinic/templates/blocks/red-flags.md`. Its file starts
with `@include red-flags`, which pulls in the shared paragraph, and then adds
a paragraph about the walk-in centre next door. In the test run South
Clinic's assistants got both paragraphs and North Clinic's got the shared one
only. Neither clinic's assistant files differ.

How the location's block is written decides whether it follows later edits
to the shared one:

| South Clinic's own block | An edit to the shared block |
| --- | --- |
| Includes the shared block and adds to it (the example) | Reaches South Clinic. Its assistants are on the `sync-blocks` list. |
| Is written out in full, with no `@include red-flags` line | Does not reach South Clinic. Its assistants are not on the list. |

Add to the shared block when you can. A location that replaces it outright
stops receiving every later change to it, including safety wording.

The lookup order is in
[Lookup order](blocks.md#lookup-order-shared-blocks-and-an-orgs-own).

### A different setting: a key beside `$include`

A file can set its own keys next to `$include`. The rule is **the file's own
keys win**. Say South Clinic wants to wait longer before it hangs up on a
silent caller. Add one line to `resources/south-clinic/squads/front-desk.yml`:

```yaml
membersOverrides:
  $include: call-settings
  silenceTimeoutSeconds: 30
  variableValues:
    practice_name: South Clinic
```

Deploy that one file. **Changes a live org.**

```bash
npm run apply -- south-clinic squads/front-desk.yml
```

What this means in practice, from the test run:

| | `silenceTimeoutSeconds` | `maxDurationSeconds` |
| --- | --- | --- |
| The block says | 20 | 900 |
| North Clinic got | 20 | 900 |
| South Clinic got | 30, from its own file | 900, from the block |

- South Clinic still follows the block for every key it does not set. When
  the block's `maxDurationSeconds` later changed to 1200, both clinics got
  1200 and South Clinic kept its 30.
- The key South Clinic sets no longer follows the block. When the block's
  `silenceTimeoutSeconds` later changed to 25, North Clinic got 25 and South
  Clinic stayed at 30. `sync-blocks` still lists South Clinic's squad for
  that edit, and pushing it changes nothing there.

Lists and nested mappings have their own rules:
[How a block and the file's own keys combine](blocks.md#how-a-block-and-the-files-own-keys-combine).

## 5. Change a shared block

A block edit changes what many assistants send to Vapi, but it changes none
of their files. So the work has three parts: make the edit on a branch and
see what it reaches, let a pull request check it, then push it to the orgs.

### On a branch

A branch is your own copy of the files to work in. Nothing on it is live.

```bash
git checkout -b red-flags-overdose
```

Edit `templates/blocks/red-flags.md`. Here one sentence is added at the end:

```text
If the caller says they have taken too much of a medicine, treat it as an emergency too.
```

Check the files, then ask what the edit reaches:

```bash
npm run validate -- north-clinic
npm run validate -- south-clinic
npm run sync-blocks
```

```text
🧩 Blocks sync (dry run: nothing is changed)
north-clinic
  assistants/pharmacy.md (block changed: blocks/red-flags.md)
  assistants/triage.md (block changed: blocks/red-flags.md)
south-clinic
  assistants/pharmacy.md (block changed: blocks/red-flags.md)
  assistants/triage.md (block changed: blocks/red-flags.md)
4 resource(s) still run the old block text. To push them: npm run sync-blocks -- --apply
```

One edited file, four assistants in two orgs. To see one org's part of the
list, run `npm run sync-blocks -- --org south-clinic`.

Commit the edit and send the branch to GitHub:

```bash
git add templates
git commit -m "Treat an overdose as an emergency"
git push -u origin red-flags-overdose
```

### In the pull request

Open a pull request for the branch on GitHub. A pull request asks to bring
your branch into `main`, and gives other people a place to read the change
first.

- **The diff shows one file.** Paste the `sync-blocks` list into the
  description, so a reviewer sees the four assistants the one file changes.
- **Validate resources** runs `validate` for every org folder on every pull
  request. A marker that names a block that does not exist fails here (see
  [Limits](#limits)).
- **PR checks**, if you have turned them on, run your simulations against the
  branch's files before anything is live. The example has no check;
  [PR checks](pr-checks.md) shows how to add one. In the test run, a check on
  North Clinic's squad was selected by the block edit, and the payload it
  built held the new sentence:

  ```text
  🔎 core: affected by templates/blocks/red-flags.md
  core / squads/front-desk
    ✅ 1 simulation × 1 iteration over chat, 2.9 KB
  ```

  A branch that changed only an unrelated file got
  `⏭️ core: not affected by changes since origin/main`. You can build the
  same payload yourself without sending anything:

  ```bash
  npm run check -- core --dry-run --print-payload
  ```

### After the merge

Merging puts the edit on `main`. It does not change any assistant, unless
your repository runs the promotion workflow
([Orgs linked by promotion](#6-orgs-linked-by-promotion)). To push the edit,
get the merged files and run one command. **Changes a live org**, in every
org on the list, and needs each org's key.

```bash
git checkout main
git pull
npm run sync-blocks -- --apply
```

For each org it runs `apply` on that org's listed files. When all of them go
through, it ends with:

```text
✅ Every resource is in sync with its blocks.
```

The push updates `state/<org>/blocks.json` in each org it touched. Commit that
the way your team commits any other change:

```bash
git add state
git commit -m "Roll out the overdose rule"
```

### When someone edited an assistant in the dashboard

`sync-blocks -- --apply` will not overwrite an edit made in the dashboard. In
the test run, North Clinic's Triage greeting was changed outside the
repository before the rollout:

```text
north-clinic
  assistants/pharmacy.md (block changed: blocks/red-flags.md)
  assistants/triage.md (block changed: blocks/red-flags.md)
🚀 Applying 2 resource(s) to north-clinic...
…
   ❌ drift detected on assistant triage [both-diverged]: … Re-run pull, resolve locally, or push with --overwrite to take ownership.
❌ north-clinic: 1 resource(s) still run the old block text:
     - resources/north-clinic/assistants/triage.md
   The output above says why: a resource edited in the dashboard is refused until that edit is resolved.
south-clinic
…
```

The command exits 1. The other three assistants were pushed: North Clinic's
Pharmacy, and both of South Clinic's. Only the edited one was left on the old
text, and `npm run sync-blocks` lists it until you resolve it:

1. Get the dashboard's version saved beside your file. Name the file, so
   nothing else is touched:

   ```bash
   npm run pull -- north-clinic --resolve=theirs assistants/triage.md
   ```

   ```text
   ⚠️  triage: the dashboard version differs, but the file uses blocks, so it was not overwritten.
       Dashboard version saved to resources/north-clinic/assistants/triage.<timestamp>.bkp.md.
       Move the dashboard edit into the file or into the block it belongs to, then run: npm run apply -- north-clinic --resolve=ours resources/north-clinic/assistants/triage.md
   ```

   Your file is not changed. (A plain `npm run pull -- north-clinic` stops here
   with `Pull halted: unresolved 3-way drift (both-diverged)` and saves
   nothing.)
2. Compare the saved copy with your file. The saved copy is the finished
   resource, so the block's text and the voice settings show up as
   differences too. Look for what differs outside them. Here it was one line:

   ```text
   < firstMessage: Thanks for calling {{practice_name}}. What can I help you with today?
   ---
   > firstMessage: North Clinic, how can I help?
   ```

3. Decide. To keep the dashboard edit, make the same change in your file, or
   in the block if every location should get it. To drop it, change nothing.
4. Push your version over the dashboard's. **Changes a live org.**

   ```bash
   npm run apply -- north-clinic --resolve=ours assistants/triage.md
   ```

5. Run `npm run sync-blocks` again. It now says every resource is in sync.
   Delete the saved copy (git ignores it), then commit your file and
   `state/`.

One case to know about. In the test run, a greeting was added in the
dashboard to an assistant whose file sets none. Pushing the file with
`--resolve=ours` did not remove that greeting, and the next `pull` no longer
reported a dashboard edit. An update only replaces the settings your file sends (see
[PATCH semantics](../learnings/assistants.md#patch-assistantid-semantics-shallow-replacement-at-the-top-level-field)).
So for a setting that exists only in the dashboard, "change nothing" does not
drop it. Name the field in your file, with the value you want or `null`, and
check the assistant after the push. With `firstMessage: null` in the file,
the engine sent the `null` and the stand-in cleared the greeting; that was
not tried on a live org.

The full table of cases is in
[Dashboard edits to a file that uses blocks](blocks.md#dashboard-edits-to-a-file-that-uses-blocks).

## 6. Orgs linked by promotion

[Promotion](promotion.md) moves files from one org to the next in a fixed
order. If your orgs are linked that way, promotion carries a block edit to
the orgs it deploys. The test run used this pipeline, from North Clinic to
South Clinic:

```yaml
pipelines:
  rollout:
    orgs:
      - north-clinic
      - south-clinic
    resources:
      - assistants/*
```

Promotion never deploys the first org of a pipeline. Push the block edit
there yourself. **Changes a live org.**

```bash
npm run sync-blocks -- --org north-clinic --apply
```

Then read the plan for the next org. The plan changes nothing:

```bash
npm run promote -- --pipeline rollout --from north-clinic --to south-clinic
```

```text
rollout: north-clinic → south-clinic
  sync   assistants/pharmacy.md (block changed: blocks/red-flags.md)
  sync   assistants/triage.md (block changed: blocks/red-flags.md)
```

`sync` marks a file that did not change itself but needs a push, because a
block it includes changed. The same command with `--apply` at the end pushes those
files. **Changes a live org.** Afterwards `npm run sync-blocks` listed nothing
for either org.

Four things the test run showed, each of which matters when the orgs are
locations rather than stages of one location:

- **Promotion copies files.** Every file that matches the pipeline's
  `resources` patterns is copied from the source org's folder to the
  destination's. When North Clinic's `triage.md` had its own greeting, the
  plan said `update assistants/triage.md`, and `--apply` made South Clinic's
  file a copy of it, North Clinic's greeting included. Put in the patterns
  only files that should be identical everywhere.
- **A location's own blocks are not copied.** After promotion South Clinic
  still had its own `red-flags` block, and its assistants still got the
  walk-in paragraph. So keep what differs per location in the location's own
  blocks, in variables, and in files outside the patterns. In the example
  that is each clinic's squad file, which sets the clinic's name.
- **Files outside the patterns are not pushed.** An edit to
  `templates/config/call-settings.yml` reaches only the squads, which the
  pipeline above does not cover. The plan said `no changes`, and both squads
  stayed on the `sync-blocks` list until `npm run sync-blocks -- --apply`
  pushed them. Run `npm run sync-blocks` after a promotion to see what is
  left.
- **Promotion overwrites dashboard edits.** A greeting changed in the
  dashboard in South Clinic was replaced by the promoted file, not refused.
  This is the opposite of `sync-blocks -- --apply`.

The promotion workflow on GitHub runs when a change under `templates/` lands
on `main`, if you have turned it on: see
[GitHub Actions](promotion.md#github-actions).

## 7. What `pull` does with these files

`pull` brings dashboard changes into your files. For a file that uses blocks
it never rewrites the file, because the dashboard holds the finished prompt
and writing that back would replace the marker with a copy of the block.

| The dashboard | What `npm run pull -- <org>` printed | Your file |
| --- | --- | --- |
| Matches the file | `🧩 triage (uses blocks, matches the dashboard — file left as written)` | Unchanged. `git status` showed nothing. |
| Was edited | `⚠️  pharmacy: the dashboard version differs, but the file uses blocks, so it was not overwritten.` | Unchanged. The dashboard version is saved beside it as `pharmacy.<timestamp>.bkp.md`. |

The same held with `--force`: the file was kept and the dashboard version
was saved beside it. Git ignores the saved copies, so they never show up in
a commit. Resolve the edit with steps 2 to 5 of
[When someone edited an assistant in the dashboard](#when-someone-edited-an-assistant-in-the-dashboard).

## Limits

**A marker with no matching block is refused.** If a file says
`@include opening-hours` and no such block exists, nothing is deployed with
the marker left in or the text missing:

```text
❌ Validation failed: Failed to expand blocks in "assistants/pharmacy.md": Unknown prompt block "opening-hours". Looked for:
  - resources/north-clinic/templates/blocks/opening-hours.md
  - templates/blocks/opening-hours.md
```

`validate`, `apply` and `sync-blocks` each stopped with that message and exit
code 1, and none of them sent anything to the API.

**A variable nobody defines is not caught.** The engine does not check Liquid
variables. A block that says `We are open {{opening_hours}}.` passed
`validate` with no warning when no squad set `opening_hours`. On a call, Vapi
leaves a variable with no value in the prompt as written, so the model sees
the braces (see the gotcha under
[Override Merge Order](../learnings/squads.md#override-merge-order)). When a
block uses a variable, give it a value in every squad that uses the block.

**Two mistakes are warnings today, not errors.** `validate` prints them and
still passes:

```text
⚠️  [liquid-file-tag] assistants/pharmacy (model.messages[0]): system prompt uses the Liquid "include" tag, which Vapi renders as nothing on a call. Share prompt text with a prompt block ("@include <name>") instead — see docs/guides/blocks.md
⚠️  [yaml-merge-key] squads/front-desk (membersOverrides): YAML merge key ("<<") is not processed: it is sent to Vapi as a field named "<<". Share config with a config block ("$include") instead — see docs/guides/blocks.md
```

Read the warnings before you deploy. Both mean shared content you expect is
not there.

More limits, including what a fresh clone means for the drift check:
[Blocks: Limits](blocks.md#limits).

## How this page was checked

Every command on this page was run in a scratch copy of this repository that
held the example's two clinics, against a local stand-in for the Vapi API.
None was run against a live org. The output shown is what those runs printed,
shortened where you see `…`. "Edited in the dashboard" means the resource
was changed on the stand-in, outside the repository. Three things were not
run at all:

- **Calls.** What Vapi does with a prompt during a call (filling
  `{{practice_name}}`, leaving an undefined variable as written) comes from the
  [squads notes](../learnings/squads.md#override-merge-order).
- **The GitHub workflows.** The commands they call (`validate`, `check`,
  `promote`) were run from a terminal instead.
- **Live simulations.** The PR check was built with `--dry-run`, so no
  simulation ran.

The stand-in is not Vapi. Where a result depends on how the API stores an
update, as with the dashboard-only setting in step 5, check it on your own
org before you rely on it.

## Where to read more

| For | Read |
| --- | --- |
| Marker syntax, merge rules, what is refused | [Blocks](blocks.md) |
| Every command and flag | [Commands](commands.md) |
| Setting up simulations for pull requests | [PR checks](pr-checks.md) |
| Setting up a promotion pipeline | [Promotion](promotion.md) |
| Pulling without losing local work | [Everyday workflows](workflows.md#pull-without-losing-local-work) |
