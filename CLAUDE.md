# Project Rules For Claude

This repository uses two instruction sources for Claude:

1. `AGENTS.md` is the primary, comprehensive guide for this codebase.
2. `CLAUDE.md` contains Claude-specific reinforcement and policy reminders.

When both files exist, follow both. If guidance overlaps, treat `AGENTS.md` as the canonical project playbook and use this file to reinforce Claude-specific behavior.

## Required Reading Order

1. Read `AGENTS.md` first.
2. Then read this file (`CLAUDE.md`) for additional policy constraints.

## Changelog Discipline

Always update `docs/changelog.md` when making significant configuration changes.

Significant changes include:
- Assistant updates (prompt or YAML frontmatter)
- Tool updates (new tools, changed parameters, changed behavior)
- Squad updates (members, handoffs, overrides)
- Other behavior-impacting resource changes (structured outputs, simulations)

Each changelog update should state:
- Date (`YYYY-MM-DD`)
- Files/resources changed
- Why the change was made
- Expected impact
