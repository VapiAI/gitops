# Blocks example: two clinics sharing prompt text and config

A minimal example of [blocks](../../docs/guides/blocks.md): shared files that
many resources include.

```text
examples/blocks/
├── templates/
│   ├── blocks/red-flags.md          shared prompt block
│   └── config/
│       ├── voice.yml                shared config block
│       └── call-settings.yml        shared config block (includes voice)
└── resources/
    ├── north-clinic/
    │   ├── assistants/triage.md     @include red-flags, $include: voice
    │   ├── assistants/pharmacy.md   @include red-flags, $include: voice
    │   └── squads/front-desk.yml    $include: call-settings
    └── south-clinic/
        ├── (the same three files)
        └── templates/blocks/red-flags.md   South Clinic's own red-flags block
```

What to notice:

- Both assistants in both orgs include the same `red-flags` block. North
  Clinic gets the shared text. South Clinic gets its own block, which
  includes the shared one and adds a paragraph.
- `{{practice_name}}` inside the blocks is left alone by the engine. Vapi
  fills it on each call from the squad's `variableValues`.
- The squad file sets `variableValues` beside `$include: call-settings`: the
  block supplies the shared settings and the file adds its own.

To try it, copy `templates/` to the root of your repository and one of the
org folders to `resources/<your-org>/`, then run:

```bash
npm run validate -- <your-org>
npm run sync-blocks
```

Both commands only read files. Deploying is `npm run apply -- <your-org>`,
which changes a live org.

[Running many locations from one set of prompts](../../docs/guides/many-locations.md)
walks through these files step by step: the first deploy, one clinic's own
wording and settings, and a block edit from branch to rollout.
