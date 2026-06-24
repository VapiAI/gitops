# Managed variables

Centralize values that repeat across resources — callback URLs, a default model
name, a shared prompt fragment, a brand name — in one place, and reference them
from any resource file with a `{{name}}` placeholder. At push the placeholder is
replaced with the managed value; at pull the placeholder is preserved.

---

## TL;DR

1. Add a `variables` section to the state file `.vapi-state.<env>.json`:
   ```jsonc
   {
     "assistants": { "...": { "uuid": "..." } },
     "variables": {
       "callback_url": "https://example.com/vapi/webhook",
       "default_model": "gpt-4.1",
       "max_tokens": 260
     }
   }
   ```
2. Reference a variable anywhere in a resource file with a **whole-value**
   placeholder:
   ```yaml
   model:
     model: "{{default_model}}"
     maxTokens: "{{max_tokens}}"   # becomes the NUMBER 260, not "260"
   server:
     url: "{{callback_url}}"
   ```
3. `npm run push -- <env>` substitutes the values. `npm run pull -- <env>`
   restores the `{{...}}` placeholders. Drift detection treats a templated file
   and its rendered platform resource as **in sync** — no phantom drift.

---

## Rules

- **Whole-value only.** A placeholder substitutes only when the *entire* value
  is a single `{{name}}`. Embedded placeholders inside a longer string
  (`"Call us at {{callback_url}}"`) are **not** substituted — they ship
  verbatim. In-string interpolation is intentionally unsupported because it
  cannot round-trip cleanly through pull/drift.
- **Type is preserved.** The managed value keeps its JSON type. `"{{max_tokens}}"`
  with `max_tokens: 260` sends the number `260`; an object-valued variable sends
  the object. (YAML needs the placeholder quoted, but the result is the native
  type.)
- **Variable names** are `[A-Za-z0-9_.-]+` — letters, digits, underscore, dot,
  hyphen. No spaces. Whitespace *inside* the braces is ignored: `{{ x }}` ==
  `{{x}}`.
- **Undefined placeholders are a validation error.** `npm run validate`/`push`
  fail (or warn, without `--strict`) on any `{{name}}` with no matching entry in
  `variables`, so a typo can't silently ship the literal string `"{{name}}"`.
- **Variables compose with references.** Substitution runs *before* resourceId →
  UUID resolution, so a variable whose value is a resourceId works:
  `toolIds: ["{{tool_ref}}"]` with `tool_ref: "my-tool"` resolves to the tool's
  UUID.

## How it round-trips (push / pull / drift)

The state file is the single source of values. push and pull never mutate the
`variables` section — you hand-edit it; the engine preserves it verbatim.

- **push** — `{{name}}` → value, then the usual reference/credential resolution,
  then the API call.
- **drift** — the local file is hashed *with variables rendered*, and the
  platform resource is already rendered, so both sides hash in one basis. A
  templated resource you haven't changed reads as `clean`, never `both-diverged`.
- **pull** — the platform value is written back, but a `{{name}}` placeholder is
  restored at any path where **your local file already had that placeholder and
  the value still matches**. This is guided by your file, so a literal value that
  merely *happens* to equal a variable's value is never rewritten into a
  placeholder. If a field was changed on the dashboard so its value no longer
  matches the variable, pull writes the literal value (the dashboard is now the
  source of truth for that field) — re-apply the placeholder by hand if you want
  it back.

## Limitations (v1)

- **No in-string interpolation** — whole-value only (see Rules).
- **No nested/recursive variables** — a variable whose value itself contains a
  `{{...}}` placeholder is not re-resolved. Single pass.
- **No `${ENV_VAR}` expansion** — variable values are literal. For per-developer
  secrets use `.env.<env>` (loaded into `process.env`), not the committed state
  file.
- **Do not store secrets in `variables`.** The state file is committed to git.
  Tokens, API keys, and signing secrets belong in credentials or `.env.<env>`.
- **`.ts` resources** keep their authored value (placeholder restoration on pull
  only applies to `.yml`/`.yaml`/`.md`), consistent with how `.ts` files are
  hashed.
- **Avoid `null`-valued variables.** Null leaves are dropped by the hash
  canonicalization, so a `null`-valued placeholder may not round-trip cleanly
  through pull/drift. Prefer a sentinel value, or omit the field.
- **Templating an entire `.md` system prompt** as a single `{{var}}` works for
  the normal case (one system message). Placeholder restoration on pull matches
  model messages positionally, so if the platform returns the messages in a
  different order than your local file, the literal rendered prompt is written
  instead of the placeholder — re-apply by hand if that happens.

## Why the state file (and not a separate file)?

Variables are the value analogue of the `name → { uuid }` reference maps the
resolver already consults. Keeping them in `.vapi-state.<env>.json` means one
lookup table, one commit, one merge surface. The migration guard
(`assertStateMigrated`) and `npm run migrate` explicitly exempt the `variables`
key, so its raw values are never mistaken for the legacy fat-state shape and
`migrate` never drops them.
