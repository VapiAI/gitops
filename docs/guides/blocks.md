# Blocks: shared prompt text and config

A block is a piece of prompt text or config that lives in one file and is
used by many resources. Change the block and every assistant and squad that
includes it changes with it, in every org.

There are two kinds:

| Kind | File | Included with | Use it for |
| --- | --- | --- | --- |
| Prompt block | `templates/blocks/<name>.md` | a line that says `@include <name>` in a system prompt | Wording several assistants share: safety rules, tone, a closing script |
| Config block | `templates/config/<name>.yml` | a `$include: <name>` key in any mapping | Settings several resources share: voice, transcriber, model settings, squad overrides |

The engine expands blocks when it loads a resource file, before `validate`,
`apply`, `push` and PR checks. Vapi only ever receives the finished resource:
blocks do not exist on the platform or in the dashboard.

Every snippet below is a file from [`examples/blocks/`](../../examples/blocks/),
two clinics that share a red-flags block and a voice. CI checks that the
snippets match the files and that the example passes `validate`.

## Prompt blocks

Put the shared text in a Markdown file:

```markdown
<!-- examples/blocks/templates/blocks/red-flags.md -->
# Emergencies

If the caller mentions chest pain, difficulty breathing or signs of a stroke,
stop what you are doing and tell them to hang up and call 999 now. Then offer
to connect them to {{practice_name}} reception.
```

Then write `@include red-flags` on a line of its own wherever the text
belongs in a system prompt:

```markdown
<!-- examples/blocks/resources/north-clinic/assistants/triage.md -->
---
name: Triage
firstMessage: Thanks for calling {{practice_name}}. What can I help you with today?
model:
  provider: openai
  model: gpt-4.1
  temperature: 0.3
voice:
  $include: voice
---

# Identity

You are the triage assistant for {{practice_name}}. You find out what the
caller needs and pass them to the right assistant.

@include red-flags

# Flow

1. Ask what the caller needs help with today.
2. For a repeat prescription, pass them to the Pharmacy assistant.
3. For anything else, take a short message for the reception team.
```

- The marker must be the only thing on its line. `@include` in the middle of
  a sentence is left as ordinary text.
- It works in every system prompt: the Markdown body of an assistant, a
  `role: system` message in a `.yml` assistant, and a system message inside
  a squad's `assistantOverrides` or `membersOverrides`. Other text fields,
  such as `firstMessage`, are not expanded.
- The name is the file's path under `templates/blocks/` without `.md`, so
  `templates/blocks/safety/red-flags.md` is `@include safety/red-flags`.
- A block can include other blocks. A block that ends up including itself is
  an error.
- A block has no parameters. What differs per call belongs in a Liquid
  variable (next section); what differs per org belongs in an org's own
  block (see [Lookup order](#lookup-order-shared-blocks-and-an-orgs-own)).

### Liquid variables

Nothing inside a block is interpreted. `{{practice_name}}`,
`{% if … %}` and every other Liquid expression reach Vapi exactly as written,
and Vapi fills them on each call, the same as if you had typed the block's
text into the prompt.

The marker is deliberately not Liquid. Vapi's call-time Liquid has no file
access: it renders `{% include %}`, `{% render %}` and `{% layout %}` as
nothing, so a prompt that relied on them would silently lose that text on a
live call. `validate` warns when a system prompt contains one of those tags.

## Config blocks

A config block is a YAML file:

```yaml
# examples/blocks/templates/config/voice.yml
provider: 11labs
voiceId: sarah
```

Any mapping can pull it in with a `$include` key. In the assistant above,
`voice:` with `$include: voice` becomes the two fields of that file. A squad
can do the same, and a block can include another block:

```yaml
# examples/blocks/templates/config/call-settings.yml
silenceTimeoutSeconds: 20
maxDurationSeconds: 900
voice:
  $include: voice
```

```yaml
# examples/blocks/resources/north-clinic/squads/front-desk.yml
name: Front Desk
members:
  - assistantId: triage
  - assistantId: pharmacy
membersOverrides:
  $include: call-settings
  variableValues:
    practice_name: North Clinic
```

### How a block and the file's own keys combine

The mapping that holds `$include` can set keys of its own. The rule is
always: **the file wins**.

| The block has | The file sets, beside `$include` | Result |
| --- | --- | --- |
| a key | nothing for that key | the block's value |
| a key | the same key, a plain value | the file's value |
| a mapping | the same key, a mapping | merged key by key, by these same rules |
| a list | the same key, a list | the file's list replaces the block's list whole. Lists are never joined. |
| anything | the same key, a different kind of value | the file's value |

So, with the voice block above:

```yaml
voice:
  $include: voice
  voiceId: burt        # provider comes from the block, voiceId from here
```

`$include` takes one name or a list of names:

```yaml
membersOverrides:
  $include: [call-settings, transcriber]
```

A block whose content is a list (or a single value) can be included only on
its own, as the whole value of a field:

```yaml
model:
  toolIds:
    $include: standard-tools     # templates/config/standard-tools.yml is a list
```

### What is refused

These fail at load, so `validate`, `apply` and PR checks all stop with a
message naming the file:

| Case | Why |
| --- | --- |
| A block that does not exist, in the org's folder or the shared one | A missing block must never become empty text or missing settings. The message lists both places it looked. |
| Blocks that include each other in a loop | No finished text exists. The message shows the chain. |
| Two blocks in one `$include` list that set the same field to different values | The result would depend on the order of the list. Set the field in one block, or in the file. |
| A list block included beside other keys or other blocks | There is no sensible way to merge a list with keys. |
| `$include` in the same mapping as a YAML merge key (`<<`) | Two merge mechanisms in one place. The engine does not process `<<` at all (see below). |
| `$include` with an empty value, a non-text value, or the same name twice | Almost certainly a typo. |

### YAML anchors and merge keys

Don't use them for sharing. An anchor only reaches inside one file, and
`pull` writes files back with every alias expanded. A merge key
(`<<: *defaults`) is not processed by the engine at all: it is sent to Vapi
as a field named `<<`. `validate` warns when it finds one.

## Lookup order: shared blocks and an org's own

A name is looked up in two places, in this order:

1. `resources/<org>/templates/`, the org's own blocks
2. `templates/` at the repository root, shared by every org

So an org replaces a shared block by having a file of the same name. An
org's block that includes its own name gets the shared one, which lets it
add to the shared block rather than copy it:

```markdown
<!-- examples/blocks/resources/south-clinic/templates/blocks/red-flags.md -->
@include red-flags

{{practice_name}} has a walk-in centre next door, open until 8pm. If the
caller is not sure it is an emergency, tell them they can go there.
```

Config blocks work the same way. This org file keeps everything in the
shared `voice` block and changes one field:

```yaml
# resources/south-clinic/templates/config/voice.yml
$include: voice
voiceId: burt
```

## Rolling a block change out

A block edit changes what many resources send to Vapi, but it changes none
of their files. Three things follow from that.

**1. See what it reaches.**

```bash
npm run sync-blocks                     # every org; reads files, changes nothing
npm run sync-blocks -- --org acme       # one org
```

It lists every resource whose blocks have changed since that resource was
last pushed, with the block that changed. An org with its own version of a
block is not listed for an edit to the shared version.

**2. Push it.**

```bash
npm run sync-blocks -- --apply
```

For each org this runs `npm run apply -- <org> <the listed files>`, so it
needs each org's API key, like any deploy, and it goes through the same
validate → pull → push path. A resource that someone edited in the dashboard
is refused by the drift check, exactly as with `apply`; the command says
which resources were left behind and exits 1. Resolve the edit (see
[Dashboard edits](#dashboard-edits-to-a-file-that-uses-blocks)) and run it
again.

Plain `npm run apply -- <org>` also pushes them: to the engine a block edit
looks like a local edit to every file that includes the block.

**3. Commit the record.** The engine knows what each resource was last pushed
with from `state/<org>/blocks.json`. Push updates it; commit it
with your other changes, as you do the state file. Don't edit it by hand. If
it is missing, every resource that uses a block is listed until it is pushed
once.

In a repository whose state is still in the layout from before `state/`, the
record is `resources/<org>/.vapi-blocks.json` instead, which the commit step
that repository already has stages with the folder. `npm run migrate` moves
it with the rest: see
[Upgrading from an older version](commands.md#upgrading-from-an-older-version).

### With promotion

When orgs are linked by a [promotion](promotion.md) pipeline (for example
one org per site, or dev → production), promotion carries block edits to the
orgs it deploys:

- A shared block is one file for every org, so there is nothing to copy. The
  plan shows each destination resource that uses the changed block as
  `sync`, and `--apply` pushes it.
- An org's own blocks are not copied to the next org. Each org is expanded
  with its own blocks, then the shared ones.
- The promotion workflow runs when `templates/**` changes, as it does for
  `resources/**`.
- Promotion deploys destination orgs only. The first org of a pipeline, and
  any org outside a pipeline, gets a block edit from `sync-blocks` or
  `apply`.

Promotion pushes with `--resolve=ours`, as it does for every file it
promotes: a dashboard edit in a destination org is overwritten, not refused.

### With PR checks

A change under `templates/` selects every [PR check](pr-checks.md), and a
change to an org's own blocks selects that org's checks. The check builds
its payload from the branch's files, so it tests the new block text.

## Dashboard edits to a file that uses blocks

The dashboard shows the finished prompt, with the block's text in place of
the marker. If `pull` wrote that back to your file, the marker would be
replaced by a copy of the block and the file would stop following later
block edits. So `pull` never rewrites a file that uses blocks:

| Situation | An ordinary file | A file that uses blocks |
| --- | --- | --- |
| File and dashboard agree | Rewritten in pull's own format | Left exactly as written |
| Only the dashboard changed | Overwritten with the dashboard version | Kept. The dashboard version is saved beside it, and the edit stays flagged as drift |
| `pull --force` | Overwritten | Kept. The dashboard version is saved beside it |
| Both changed, `--resolve=theirs` | Overwritten | Kept. The dashboard version is saved beside it, and the conflict stays open |

"Saved beside it" means a `<name>.<timestamp>.bkp.md` (or `.yml`) file next
to yours, which git and the engine ignore. To resolve a dashboard edit:

1. Compare the saved copy with your file and find what was changed.
2. If the change is in text that comes from your file, make the same change
   in your file. If it is in text that comes from a block, change the block
   (every resource that uses it changes too) or give this org its own block.
   To discard the dashboard edit, change nothing.
3. Run `npm run apply -- <org> --resolve=ours <file>`. It pushes your
   version over the dashboard's.

## Limits

- The drift check compares the dashboard with the last state *your* checkout
  saw (see [sync behavior](../learnings/sync-behavior.md)). A fresh clone
  has no such baseline, so its first push is not refused. This is the same
  for every push, with or without blocks.
- An org with no credentials stored in Vapi gets no drift check at all:
  `push` re-syncs such an org's state before every run, which resets the
  baseline to whatever the dashboard holds. This also predates blocks (see
  `improvements.md`, entry 42).
- Blocks are expanded in `.md`, `.yml` and `.ts` resources. As with any
  `.ts` resource, `pull` and drift detection skip `.ts` files.
- A pull request shows a block's diff once. Run `npm run sync-blocks` on the
  branch to see every resource and org it reaches.
- `templates/` is not a resource folder. Nothing in it is pushed on its own,
  and `cleanup` and `audit` don't look there.
