# Environment-Scoped Resource Directories

## Overview

Resources are stored in environment-scoped subdirectories under `resources/`. The engine reads only from the directory matching the active environment, preventing cross-environment contamination.

```
resources/
  dev/          <- push:dev reads/writes here
  stg/          <- push:stg reads/writes here
  prod/         <- push:prod reads/writes here
```

Each environment directory mirrors the same internal structure (`assistants/`, `tools/`, `squads/`, etc.).

## How It Works

The engine resolves `RESOURCES_DIR` as `resources/<env>/` based on the environment argument passed to every command (`dev`, `stg`, `prod`). All modules (`push.ts`, `pull.ts`, `resources.ts`, `delete.ts`, `resolver.ts`) operate relative to this single path.

| Command | Reads from | State file | Env file |
|---------|-----------|------------|----------|
| `push:dev` | `resources/dev/` | `.vapi-state.dev.json` | `.env.dev` |
| `push:stg` | `resources/stg/` | `.vapi-state.stg.json` | `.env.stg` |
| `push:prod` | `resources/prod/` | `.vapi-state.prod.json` | `.env.prod` |
| `pull:dev` | writes to `resources/dev/` | `.vapi-state.dev.json` | `.env.dev` |
| `pull:stg` | writes to `resources/stg/` | `.vapi-state.stg.json` | `.env.stg` |
| `pull:prod` | writes to `resources/prod/` | `.vapi-state.prod.json` | `.env.prod` |

Resource IDs are computed relative to the resource type directory inside the environment scope, so existing state file mappings remain valid.

## The Three Environments

### dev — Experimentation and rapid iteration

- Build and test new assistants, tools, squads
- Try prompt changes, test handoff flows, validate tool integrations against mock servers
- Anyone can push at any time, no approval needed
- May contain resources pointing to mock/ngrok tool endpoints for local testing

### stg — Pre-production validation

- Validate resources in a production-like environment before going live
- Run simulation suites, conduct QA calls, verify tool integrations against real endpoints
- Resources should use production tool endpoints, never mock/ngrok
- Acts as a gate — if something breaks here, it does not reach prod

### prod — Live

- Resources actively handling real calls
- Only push after successful validation in stg
- Changes should be deliberate and reviewed

## Promotion Workflow

Resources flow in one direction: **dev -> stg -> prod**.

### Promoting dev -> stg

```bash
# Copy files
cp resources/dev/assistants/my-agent.md resources/stg/assistants/
cp resources/dev/tools/my-tool.yml resources/stg/tools/

# Review: ensure tool URLs point to production endpoints, not mock/ngrok

# Push to staging
npm run push:stg
```

**Note:** The first push to a new environment creates fresh resources in that Vapi org (new UUIDs). The state file for that environment (e.g. `.vapi-state.stg.json`) starts empty, so every resource is treated as a new creation. Subsequent pushes update the existing resources via their tracked UUIDs.

### Promoting stg -> prod

```bash
# Copy files
cp resources/stg/assistants/my-agent.md resources/prod/assistants/
cp resources/stg/tools/my-tool.yml resources/prod/tools/

# Push to production
npm run push:prod
```

### Skipping staging (dev -> prod directly)

For urgent fixes, copy directly from dev to prod. Ensure production endpoints are used. Not recommended for routine changes once staging is available.

## Naming Conventions Within an Environment

Within `resources/dev/`, the `*-mock` and `*-prod` suffixes on filenames indicate which **tool endpoints** the resource uses, not which Vapi org it targets:

| Suffix | Tool endpoints | Vapi org |
|--------|---------------|----------|
| `*-mock` | ngrok mock server | dev |
| `*-prod` | production APIs | dev |

When promoting from dev, only copy the `*-prod` endpoint variants forward. The `*-mock` variants are dev-only.

## Setting Up a New Environment

1. Create `.env.<env>` with the `VAPI_TOKEN` for that Vapi org
2. Run `pull:<env>` to populate `resources/<env>/` and `.vapi-state.<env>.json`
3. Or seed manually by copying files from another environment's directory
