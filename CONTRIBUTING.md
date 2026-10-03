# Contributing

Thanks for helping improve Vapi GitOps. Bug reports, docs fixes and new
learnings are all welcome.

## Reporting a problem

- **Bugs and feature requests:** open a [GitHub issue](https://github.com/VapiAI/gitops/issues/new/choose).
  For bugs, include the command you ran, its output (with API keys removed),
  your Node version, and whether the org is in the US or EU region.
- **Security issues:** don't open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Questions about the Vapi platform itself** (not this repo) belong with
  [Vapi support](https://docs.vapi.ai).

## Making a change

1. Fork the repository and create a branch.
2. Install and check that everything passes before you start:

   ```bash
   nvm use
   npm ci
   npm run build   # type-checks src/ and tests/
   npm test
   ```

3. Make your change, with tests for any behaviour change. Tests use
   `node:test` and live in `tests/`; they never call the real Vapi API.
4. Run `npm run build` and `npm test` again, then open a pull request.

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
(`fix(pull): …`, `feat(check): …`, `docs: …`).

## Where things go

| You're adding… | Put it in |
| --- | --- |
| A Vapi platform gotcha, recipe or troubleshooting guide | `docs/learnings/<topic>.md`, plus a row in [`docs/learnings/README.md`](docs/learnings/README.md) and the table in `AGENTS.md` for a new file |
| A sync-engine pain point and its fix (pull, push, state, cleanup) | `improvements.md`, in its Problem → Current behavior → Risk → Current mitigation → Possible fix → Status format |
| Setup or orientation for new users | `README.md` (keep it short; link to a guide for depth) |
| An example users can copy | `examples/`. Snippets in the docs that start with `# examples/<path>` must match the file exactly; `npm test` checks this. |

Don't edit `docs/changelog.md` here. It's a template for your own
deployment's change log once you fork the repo.

Coding agents (Claude Code, Cursor, Codex) read [`AGENTS.md`](AGENTS.md) and
[`CLAUDE.md`](CLAUDE.md); keep them in step when a convention changes.
