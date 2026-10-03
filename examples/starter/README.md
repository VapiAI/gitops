# Starter example

A small dental-clinic front desk, as a complete gitops org:

- two assistants (`receptionist`, `scheduler`) with a handoff between them;
- function tools, a structured output, and a squad (`front-desk`);
- a simulation suite (`core`) with a personality, a scenario that mocks its
  tools, and a check in `vapi-checks.yml`.

The README's File Formats section is built from these files, and CI checks
that every example here passes `validate` and that the PR check builds. To
try it:

```bash
cp -R examples/starter/resources/starter resources/my-org
npm run validate -- my-org
npm run check -- core --dry-run   # after adapting vapi-checks.yml to my-org
```

Replace the `example.com` server URLs with your own endpoints before you
deploy. Nothing under `examples/` is loaded by the engine.
