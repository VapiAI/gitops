# Credential pins: `credentialIds` lists

An assistant, a squad member's `assistantOverrides` and a squad's
`membersOverrides` can each carry a `credentialIds` list. It pins a call to
specific keys, for example one site's Azure OpenAI key in an org that holds a
key per site. This page explains what the list does on a call and what
`npm run validate` checks about it.

## What a list does

A `credentialIds` list is not a choice for one provider. It is the full set
of keys the call may use:

- As soon as any assistant on the call has a list, the call can use only the
  listed keys. Every squad member's list is pooled into one list for the
  whole call, so a list on one member narrows the other members too.
- A provider whose key is not on the list does not fail. The model, voice or
  transcriber runs on Vapi's own key, a tool or server request goes out
  without its key, and the recording does not go to your storage bucket.
- The phone number's own credential stays usable whatever the list says.

So a list has to name every key the call needs: the model key, the voice
key, the transcriber key, each key a tool or server names in `credentialId`,
the storage bucket key and the Langfuse key if the org has them.

Lists combine like this:

| Where the list is | What happens |
| --- | --- |
| On the assistant | Kept. Lists from overrides are added to it. |
| In a member's `assistantOverrides` | Used, unless the squad's `membersOverrides` also has a list, which replaces it. |
| In the squad's `membersOverrides` | Applies to every member. |

One list per squad, in `membersOverrides`, is the simplest layout: shared
assistants carry no list, and each squad names its own keys.

```yaml
# resources/<org>/squads/south-front-desk.yml
name: South Front Desk
members:
  - assistantId: triage
  - assistantId: pharmacy
membersOverrides:
  credentialIds:
    - azure-south        # this site's Azure OpenAI key
    - elevenlabs         # voice
    - deepgram           # transcriber
    - crm-webhook        # the key the lookup tool names
    - recordings         # storage bucket
```

## What validate checks

`npm run validate -- <org>` (and `apply`, which runs it first) reports a list
that leaves out a key **the org has saved** for something the call uses:

| The call uses | Reported when |
| --- | --- |
| A model, voice or transcriber, or a fallback voice or transcriber | The org has a key for that provider and the list has none. An OpenAI model can run on an `openai` key or an `azure-openai` key, so either on the list is enough. Every other provider takes a key saved under its own name. |
| A tool, server or model that names a key in `credentialId` | That key is not on the list. |
| Storage | The org has a storage bucket key and the list has none. |
| Langfuse | The org has a Langfuse key and the list leaves it out. |

It does not report a provider the org has no key of its own for. Running
that provider on Vapi's key is a normal setup, with or without a list.

A different key for the same provider counts as a key for it. A squad pinned
to one site's Azure OpenAI key is not told about the other sites' keys.

For a squad, the check looks at the call as a whole: the pooled list, and
what every member uses after its overrides are applied. An assistant with a
list of its own is also checked on its own, since it can be called outside a
squad.

The finding is `credential-pin-hides-key`:

```text
⚠️  [credential-pin-hides-key] squads/south-front-desk (credentialIds): the voice of member "triage" and the voice of member "pharmacy" use 11labs, and this org has "elevenlabs" saved for it, but the call's credentialIds list ("azure-south", "deepgram") has no key for 11labs. A call that has a credentialIds list can use only the keys on it, so 11labs would run on Vapi's own key, not yours. Add the key to the list
```

### Limits

- The check reads files. A squad member that is not a file in the org's
  folder (a dashboard-owned assistant) adds nothing to it.
- It knows each key's provider, not which models or regions the key covers.
  A list with an Azure OpenAI key that does not serve the assistant's model
  passes.
- A tool or server with no `credentialId` is not checked.
- Lists added at call time (`assistantOverrides` on a call or a phone
  number) are outside the repo and are not seen.

## Orgs that must only use their own keys

By default the finding is a warning. For an org whose calls must never run
on Vapi's keys, add a policy file and commit it:

```yaml
# resources/<org>/.vapi-policy.yml
customerKeysOnly: true
```

In that org the finding is an error: `validate` fails, `apply` stops before
it pulls or pushes, and the **Validate resources** check fails on the pull
request. `npm run push` on its own only blocks on errors with `--strict`,
like every other validation error.

The policy belongs to one org. Promotion does not copy it, so set it in each
org that needs it. An unknown key in the file stops `validate`, so a typo
can't switch the rule off.

The policy makes a hidden key an error. It does not require the org to have
a key for every provider it uses.

## How the check knows what each key is for

The state file maps a credential's name to its UUID and nothing else. Pull
also records each key's provider in
`resources/<org>/.vapi-credential-providers.json`:

```json
{
  "azure-south": { "provider": "azure-openai" },
  "elevenlabs": { "provider": "11labs" },
  "recordings": { "bucket": true, "provider": "azure" }
}
```

Commit it with the state file. It holds no secret. Every pull rewrites it,
including `npm run pull -- <org> --bootstrap`, which changes no resource
file. If the file is missing or older than the state file, the check reports
`credential-pin-unchecked` and asks for that pull.

Give every key a name in Vapi before the first pull. Two keys with no name
and the same provider get the same name here, and only one is kept. Pull
warns when that happens.

## Promotion

A credential with the binding policy `omit` is dropped from a promoted file.
For a single `credentialId` that is the point. For an entry in a
`credentialIds` list it narrows what calls in the destination may use, so
the plan says so:

```text
release: dev → prod
  update squads/south-front-desk.yml
  ⚠️  squads/south-front-desk.yml: credentialIds entry "elevenlabs" is left out in prod (binding policy "omit"). Calls there can use only the keys still on the list, so that provider would run on Vapi's own key.
```

See [Promotion](promotion.md) for bindings.
