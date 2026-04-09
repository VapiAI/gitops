# Project Rules For Claude

This repository uses two instruction sources for Claude:

1. `AGENTS.md` is the primary, comprehensive guide for this codebase.
2. `CLAUDE.md` contains Claude-specific reinforcement and policy reminders.

When both files exist, follow both. If guidance overlaps, treat `AGENTS.md` as the canonical project playbook and use this file to reinforce Claude-specific behavior.

## Required Reading Order

1. Read `AGENTS.md` first.
2. Then read this file (`CLAUDE.md`) for additional policy constraints.
3. When configuring any resource (tools, assistants, squads, structured outputs, simulations), consult the relevant file in `docs/learnings/` for non-obvious backend behaviors and silent defaults that can cause unexpected runtime results. See `docs/learnings/README.md` for the index.
