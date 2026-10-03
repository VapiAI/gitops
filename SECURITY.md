# Security

## Reporting a vulnerability

Please report security issues privately through GitHub:
[**Report a vulnerability**](https://github.com/VapiAI/gitops/security/advisories/new)
(the repository's Security tab). Don't open a public issue or pull request
for a suspected vulnerability.

Include what you found, how to reproduce it, and the impact you expect. We'll
acknowledge the report and keep you updated as we investigate.

## Keeping your deployment safe

- **Never commit API keys.** Keys live in `.env.<org>` files, which are
  gitignored, or in CI secrets. The tools never accept a key as a command-line
  flag, so it can't leak into shell history.
- **Committed state contains IDs, not secrets.** `.vapi-state.<org>.json` maps
  resource names to Vapi UUIDs. Credential secrets and phone-number
  provisioning are never written to the repository.
- **`.ts` resource files run code.** Loading a TypeScript resource executes its
  module, including in `validate`, `promote` plans and PR checks. Review them
  like code, and only run them from trusted branches.
- **PR checks run with your key on same-repository branches.** Forked PRs get
  a dry run with no secrets. See "Cost and safety" in the README's
  PR Checks section for what a check still sends to real providers.
