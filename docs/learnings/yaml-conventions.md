# YAML Authoring Conventions

Common YAML pitfalls in gitops resource files — shapes that look right but break at runtime, plus parser-specific scalar coercion gotchas. Read before authoring or auditing any `.yml` / `.md` frontmatter resource.

---

## YAML 1.1 Boolean Coercion

YAML 1.1 (and many widely-used parsers) interprets these unquoted scalars as **booleans**, not the string values they appear to be:

| Unquoted | YAML 1.1 type | YAML 1.2 type |
|---|---|---|
| `yes` / `no` | boolean true / false | string |
| `on` / `off` | boolean true / false | string |
| `true` / `false` | boolean | boolean |
| `null` / `~` | null | null |

This matters for any field whose runtime contract expects a specific string sentinel. A common pattern in resource APIs is `field: 'off' | { provider: ..., ... }` — the string `'off'` disables a feature, and a populated object configures it. If a YAML 1.1 parser silently coerces unquoted `off` to boolean `false`, the request body sends a boolean where the schema expects a string, and class-validator (or the equivalent) rejects it.

```yaml
field: off       # ⚠️ becomes boolean `false` in YAML 1.1 parsers
field: 'off'     # ✅ stays the string "off"
field: "off"     # ✅ stays the string "off"
```

### Parsers that default to YAML 1.1
- Symfony YAML
- ruamel.yaml (non-strict mode)
- PyYAML (default — has been YAML 1.1 since the project started)
- js-yaml v3 (legacy)

### Parsers that default to YAML 1.2
- js-yaml v4+
- libyaml-based parsers (most modern Go and Rust YAML libraries)

The gitops engine here uses js-yaml v4, which is YAML 1.2 — `off` parses as a string. But if your CI/CD pipeline pre-processes resource files (templating, validation, splicing) through a different tool, the round-trip can corrupt scalars before the engine ever sees them.

### Defense

**Default rule:** quote any string scalar that resembles a boolean / null sentinel.

```yaml
status: 'off'      # not: status: off
flag: 'no'         # not: flag: no
state: 'null'      # only quote if 'null' is a literal string value, not actual null
```

Better still, **omit the field entirely** when the desired state is "default / disabled / unset" — that is unambiguous regardless of parser:

```yaml
# Cleanest — relies on schema default
assistant:
  name: "..."
  model: { ... }
  # (no `field` key — disabled by default)

# Acceptable — explicit-off for audit visibility in diffs
assistant:
  field: 'off'   # always quote

# Avoid
assistant:
  field: off     # ⚠️ parser-dependent
```

---

## Whitespace-Only Strings Are Truthy

Many runtime code paths use truthiness checks (`if (config.field)`) to gate behavior. Empty strings are falsy, but **whitespace-only strings are truthy**:

| Value | JS truthiness |
|---|---|
| `""` | falsy |
| `" "` (single space) | **truthy** |
| `"\n"` | **truthy** |
| `null` / `undefined` | falsy |

If you intend "do nothing / silent / disabled," use the empty string `""` or omit the field. A YAML field accidentally written as `field: ` with a trailing space then newline can produce `field: " "` after some parsers — which then triggers behavior the author thought was disabled.

Audit pattern: when grepping for "disabled" config in resource files, search for both empty-string AND whitespace-only forms (`'^field:\s+$'` matches the dangerous case).

---

## Discriminated Unions: Sentinels Live at the Parent Level

Some fields accept either a sentinel string OR a structured object — e.g. `field: 'off' | { provider: '...', ... }`. The validator's discriminated union does NOT recognize a `provider: 'off'` object as the disable case. Use the top-level scalar.

```yaml
# ✅ Valid — top-level scalar sentinel
field: 'off'

# ❌ Invalid — provider doesn't have an 'off' variant in the union
field:
  provider: 'off'
```

Generalized rule: when a field type is `Sentinel | Object`, the sentinel always lives at the parent level, never as an inner field of the object form. Treating "off" as just another provider is intuitive but wrong — disable is a top-level concept, not a per-provider setting.

---

## Deprecated-Field Footguns

When a schema migrates from `featureEnabled?: boolean` (deprecated) to `feature: 'off' | Object`, both fields may still be visible in dashboard / API responses simultaneously. The runtime usually short-circuits on the new field — so:

```yaml
feature: 'off'
featureEnabled: true   # ⚠️ ignored at runtime, but visible in dashboard UI
```

Customer confusion is common because both fields appear in dashboard UI but only one drives runtime behavior. When authoring resource files, drop the deprecated field entirely if the schema offers a direct replacement.

If you find yourself auditing a resource where the new field and the deprecated field disagree, the new field always wins — but fix the file to use only the new field so future readers don't have to know that.

---

## Multi-Line Strings: `|` vs `|+` vs `|-`

Three block-scalar indicators with different newline-trimming behavior:

| Indicator | Trailing newlines |
|---|---|
| `\|` (clip, default) | Single `\n` preserved |
| `\|-` (strip) | All trailing newlines removed |
| `\|+` (keep) | All trailing newlines preserved |

For prompt-body content that is consumed as a string (system prompts, tool descriptions), prefer `|-` if the consumer trims whitespace anyway, and `|+` if you want intentional padding (e.g., a trailing blank line before user content is appended).

```yaml
# Trailing-newline-sensitive — use the explicit form
description: |-
  Hang up the call when the driver explicitly declines.

# Padding-intentional — use keep
template: |+
  Here is the transcript:

  {{transcript}}

```

Mixing `|` and `|-` inconsistently across resources makes the rendered output hard to diff visually. Pick one convention per file or per field family.

---

## Anchors and Aliases: Engine Support Varies

YAML supports `&anchor` and `*alias` for DRY-ing repeated structures. **Many gitops engines do NOT round-trip anchors faithfully** — they parse them, but on save they expand the alias inline. This means:

- A resource file you wrote with anchors will get rewritten with the anchors expanded after the next push.
- The diff after `npm run pull` will look enormous because every alias becomes its full expansion.
- Reviewers reading the rewritten file lose the "this section is intentionally a copy of X" signal.

**Recommendation:** avoid anchors/aliases in gitops resource YAML even if your local parser supports them. Duplicate the content explicitly. The maintenance cost of duplication is real but visible; the maintenance cost of silently-expanding anchors is invisible until someone tries to update both copies and only finds one.

---

## Quoting in Frontmatter Markdown Files

Assistant resource files use YAML frontmatter (`---` fenced) followed by a Markdown prompt body. The frontmatter follows all the rules above, but with one extra gotcha: **the `---` close-fence must be on its own line, immediately followed by a newline**. A common mistake:

```markdown
---
name: My Assistant
model:
  provider: openai
---# Role          ← BROKEN: fence not isolated
```

Most parsers will treat this as a malformed frontmatter and fail to extract the YAML. Always:

```markdown
---
name: My Assistant
model:
  provider: openai
---

# Role
```

The blank line after `---` is conventional; the strict requirement is just that `---` ends the line cleanly. But humans grep for `\n---\n\n# ` patterns when looking for prompt boundaries, so the blank line aids readability.

---

## Working with `.vapi-ignore`

`.vapi-ignore` lives at `resources/<org>/.vapi-ignore` and excludes specific resources from pull and push so the dashboard stays the source of truth for them. See `AGENTS.md` (line 13) for the basic gitignore-style syntax.

The recovery flow when a sync surfaces "drift" you didn't expect — typically prompted by "was that not in the .vapi-ignore?":

1. **Inspect first**, don't edit. Diff the file against `main` to see whether the path was already ignored:
   ```bash
   git diff origin/main -- resources/<org>/.vapi-ignore
   ```
2. **If a dashboard-only asset is genuinely missing from `.vapi-ignore`**, add the pattern. Otherwise stop here — the asset belongs in yaml.
3. **Dry-run before applying** to confirm only the intended assets will change:
   ```bash
   npm run push -- <org> --dry-run
   ```
4. **Apply** once the dry-run is clean: `npm run push -- <org>`.

**Cardinal rule:** don't edit `.vapi-ignore` without explicit user direction. The file encodes intentional dashboard-vs-yaml ownership splits the user (or an earlier customer-engagement decision) knows about. Removing a pattern silently re-claims an asset for gitops control, which can blow away dashboard-only edits on the next push.

**Anti-pattern:** editing `.vapi-ignore` because a sync surfaced an unexpected diff is *removing the protection*, not fixing the cause. The cause is usually upstream: the asset was edited in both places, or a new asset that should be dashboard-owned was created via gitops. Resolve at the source, then leave `.vapi-ignore` alone.

---

## Cross-references

- `docs/learnings/assistants.md` — assistant-specific frontmatter authoring
- `docs/learnings/tools.md` — tool YAML conventions (function descriptions, message blocks)
- `docs/learnings/squads.md` — squad YAML conventions (member overrides, handoff destinations)
