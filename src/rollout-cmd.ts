// npm run rollout -- advance|abort|status [--org <org>] [--assistant <id>]
//
// The ramp side of a gradual rollout. `advance` (the rollout workflow runs it
// every 15 minutes) moves each ramp in a rollout org one step once its
// interval has passed; `abort` puts an active ramp back on its old version;
// `status` lists ramps. Each assistant's newest traffic allocation is the
// ramp's whole state, so this commits nothing.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrgConnection } from "./org-connection.ts";
import { connectionLoad, tokensParse } from "./org-connection.ts";
import type { PromotionConfig, PromotionRollout } from "./promotion.ts";
import { promotionConfigParse, promotionStateParse } from "./promotion.ts";
import type {
  Allocation,
  RolloutApi,
  RolloutVersionHealth,
} from "./rollout-api.ts";
import { allocationConflictGet, rolloutApiCreate } from "./rollout-api.ts";
import { rolloutMarkerParse } from "./rollout-marker.ts";
import type { RolloutTickWrite } from "./rollout-tick.ts";
import { rolloutAbortWrite, rolloutTickDecide } from "./rollout-tick.ts";
import { RUN_ID_ENV } from "./user-agent.ts";

type RolloutAction = "advance" | "abort" | "status";

interface RolloutArguments {
  action: RolloutAction;
  org?: string;
  assistant?: string;
}

export interface RolloutDeps {
  rolloutApi: (connection: OrgConnection) => RolloutApi;
  now: () => number;
}

const ROOT_DIR = resolve(
  process.env.VAPI_GITOPS_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
);
const TOKENS_ENV = "VAPI_PROMOTION_TOKENS";
const USAGE =
  "Usage: npm run rollout -- advance|abort|status [--org <org>] [--assistant <id>]";
const ACTIONS: RolloutAction[] = ["advance", "abort", "status"];

function argumentsParse(args: string[]): RolloutArguments {
  const [action, ...rest] = args;
  if (!ACTIONS.includes(action as RolloutAction)) throw new Error(USAGE);
  const parsed: RolloutArguments = { action: action as RolloutAction };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === "--org" && rest[index + 1]) {
      parsed.org = rest[++index];
      continue;
    }
    if (argument === "--assistant" && rest[index + 1]) {
      parsed.assistant = rest[++index];
      continue;
    }
    throw new Error(`Unrecognized or incomplete argument: ${argument}\n${USAGE}`);
  }
  // An abort is an emergency stop for a ramp someone chose, never a sweep.
  if (parsed.action === "abort" && !parsed.org)
    throw new Error("abort needs --org (and optionally --assistant)");
  return parsed;
}

// Assistant resource ID → UUID in the org's state.
function assistantsLoad(org: string): Array<{ id: string; uuid: string }> {
  const path = resolve(ROOT_DIR, `.vapi-state.${org}.json`);
  if (!existsSync(path)) return [];
  const state = promotionStateParse(readFileSync(path, "utf8"));
  return Object.entries(state.assistants)
    .filter(([, entry]) => entry?.uuid)
    .map(([id, entry]) => ({ id, uuid: entry.uuid }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameWrite(allocation: Allocation | null, tick: RolloutTickWrite): boolean {
  if (!allocation) return false;
  const marker = rolloutMarkerParse(allocation.description);
  const intended = rolloutMarkerParse(tick.write.description);
  return (
    marker?.kind === intended?.kind &&
    marker?.from === intended?.from &&
    marker?.to === intended?.to &&
    marker?.step === intended?.step &&
    JSON.stringify(allocation.targets) ===
      JSON.stringify(tick.write.targets ?? [])
  );
}

// Writes with compare-and-set. A 409 that turns out to be this same write
// (a retried request that had committed) is success; any other means someone
// changed the split meanwhile, so the ramp stops for a human to look.
async function tickWrite(
  api: RolloutApi,
  label: string,
  tick: RolloutTickWrite,
): Promise<void> {
  try {
    await api.allocationCreate(tick.write, tick.command);
    console.log(`  ${label}: ${tick.summary}`);
  } catch (error) {
    if (allocationConflictGet(error) !== "stale_allocation") throw error;
    const newest = await api.allocationLatestGet(tick.write.assistantId);
    if (sameWrite(newest, tick)) {
      console.log(`  ${label}: ${tick.summary}`);
      return;
    }
    console.log(
      `  ${label}: the split changed meanwhile (${newest?.description ?? newest?.allocationIntent ?? "none"}); left for a human`,
    );
  }
}

async function orgRun(
  config: PromotionConfig,
  org: string,
  args: RolloutArguments,
  deps: RolloutDeps,
  tokens: Map<string, string>,
): Promise<string[]> {
  const rollout = config.orgs[org]?.rollout;
  if (!rollout) return [];
  const api = deps.rolloutApi(
    connectionLoad({
      rootDir: ROOT_DIR,
      org,
      tokens,
      tokensEnvName: TOKENS_ENV,
      baseUrl: config.orgs[org]?.baseUrl,
    }),
  );
  console.log(`\n${org}`);
  if (!(await api.allocationsProbe())) {
    console.log("  skipped: traffic splitting is not enabled for this org");
    return [];
  }
  const failures: string[] = [];
  const runId = process.env[RUN_ID_ENV];
  for (const { id, uuid } of assistantsLoad(org)) {
    if (args.assistant && args.assistant !== id) continue;
    try {
      const allocation = await api.allocationLatestGet(uuid);
      if (!rolloutMarkerParse(allocation?.description)) continue;
      if (args.action === "abort") {
        const tick = rolloutAbortWrite(uuid, allocation, runId);
        if (tick) await abortWrite(api, id, tick, runId);
        else console.log(`  ${id}: no active ramp to abort`);
        continue;
      }
      const assistant = await api.assistantGet(uuid);
      const now = deps.now();
      const decision = rolloutTickDecide({
        assistantId: uuid,
        allocation,
        latestVersion: assistant?.latestVersion ?? null,
        rollout,
        now,
        runId,
        health: await healthRead(api, rollout, allocation, now),
      });
      if (args.action === "advance" && decision.write)
        await tickWrite(api, id, decision.write);
      if (args.action === "status" || !decision.write)
        console.log(
          `  ${id}: ${decision.note ?? decision.write?.summary ?? "no ramp"}${decision.stale ? "  ⚠️" : ""}`,
        );
    } catch (error) {
      failures.push(`${org}/${id}: ${messageOf(error)}`);
    }
  }
  return failures;
}

// Per-version calls since the current step began, read only when a gated
// step is due, since each read is a metrics query.
async function healthRead(
  api: RolloutApi,
  rollout: PromotionRollout,
  allocation: Allocation | null,
  now: number,
): Promise<RolloutVersionHealth[] | undefined> {
  if (!rollout.healthGate || !allocation) return undefined;
  if (rolloutMarkerParse(allocation.description)?.kind !== "step")
    return undefined;
  const since = Date.parse(allocation.createdAt);
  if (now - since < rollout.intervalMinutes * 60_000) return undefined;
  return api.healthGet(allocation.assistantId, new Date(since), new Date(now));
}

// An abort is idempotent in intent, so a lost race is retried once against
// the newest row.
async function abortWrite(
  api: RolloutApi,
  label: string,
  tick: RolloutTickWrite,
  runId?: string,
): Promise<void> {
  try {
    await api.allocationCreate(tick.write, tick.command);
    console.log(`  ${label}: ${tick.summary}`);
    return;
  } catch (error) {
    if (allocationConflictGet(error) !== "stale_allocation") throw error;
  }
  const newest = await api.allocationLatestGet(tick.write.assistantId);
  const retry = rolloutAbortWrite(tick.write.assistantId, newest, runId);
  if (!retry) {
    console.log(`  ${label}: no active ramp to abort any more`);
    return;
  }
  await api.allocationCreate(retry.write, retry.command);
  console.log(`  ${label}: ${retry.summary}`);
}

export async function rolloutCommandRun(
  args = process.argv.slice(2),
  overrides: Partial<RolloutDeps> = {},
): Promise<void> {
  const deps: RolloutDeps = {
    rolloutApi: rolloutApiCreate,
    now: Date.now,
    ...overrides,
  };
  const parsed = argumentsParse(args);
  const configPath = resolve(ROOT_DIR, "promotion.yml");
  if (!existsSync(configPath)) {
    console.log("No promotion.yml, so no rollout to run.");
    return;
  }
  const config = promotionConfigParse(readFileSync(configPath, "utf8"));
  const orgs = Object.keys(config.orgs).filter(
    (org) => config.orgs[org]?.rollout && (!parsed.org || parsed.org === org),
  );
  if (parsed.org && orgs.length === 0)
    throw new Error(`${parsed.org} has no rollout: in promotion.yml`);
  if (orgs.length === 0) {
    console.log("No org in promotion.yml has rollout:, so nothing to do.");
    return;
  }
  const tokens = tokensParse(TOKENS_ENV);
  delete process.env[TOKENS_ENV];
  const failures: string[] = [];
  for (const org of orgs)
    failures.push(...(await orgRun(config, org, parsed, deps, tokens)));
  if (failures.length > 0)
    throw new Error(
      `Rollout ${parsed.action} failed for:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
    );
}

const isMainModule =
  resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  rolloutCommandRun().catch((error: unknown) => {
    console.error(`❌ Rollout failed: ${messageOf(error)}`);
    process.exit(1);
  });
}
