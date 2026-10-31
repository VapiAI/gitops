// The promote side of a gradual rollout: around the one apply child that
// publishes a transition's assistants, pin each changed assistant to the
// version it serves now, so the publish lands at 0%, then write step 1 (or
// undo the pin when nothing was published). The rollout ticker
// (rollout-cmd.ts) takes the ramp from there.
//
// Order is the whole safety argument. A publish under follow-latest moves
// 100% of calls at once, so every pin is written before the child runs, the
// child never runs with a pin missing, and step 1 or the undo runs in a
// `finally` so a failed child can't strand an assistant at 0%.

import { millipercentage } from "./promotion.ts";
import type {
  Allocation,
  AllocationTarget,
  AllocationWrite,
  RolloutApi,
} from "./rollout-api.ts";
import { allocationConflictGet } from "./rollout-api.ts";
import type { RolloutMarker, RolloutPrevious } from "./rollout-marker.ts";
import {
  rolloutMarkerFormat,
  rolloutMarkerParse,
  versionNumber,
} from "./rollout-marker.ts";
import { RUN_ID_ENV } from "./user-agent.ts";
import { VapiApiError } from "./vapi-client.ts";

export interface RolloutAssistantRef {
  // The resource ID: its path under assistants/ without the extension.
  id: string;
  uuid: string;
}

// One assistant as a preflight read found it.
export interface RolloutRead {
  ref: RolloutAssistantRef;
  latestVersion: string;
  allocation: Allocation | null;
}

export interface RolloutPin {
  read: RolloutRead;
  // The version the pin holds at 100%, which the ramp moves traffic from.
  from: string;
  pin: Allocation;
  // The row the pin's compare-and-set replaced: what an undo writes back.
  replaced: Allocation | null;
}

// A rollout refused before anything was written.
export class RolloutRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolloutRefusal";
  }
}

// A write that succeeded without a compare-and-set (there was no allocation
// to compare against) but was no longer the newest row when read back.
class RolloutNotOurs extends Error {}

function runId(): string | undefined {
  return process.env[RUN_ID_ENV];
}

function splitDescribe(targets: AllocationTarget[]): string {
  return targets
    .map((target) => `${target.assistantVersion} ${target.percentage}%`)
    .join(" / ");
}

function markerGet(allocation: Allocation | null): RolloutMarker | null {
  return rolloutMarkerParse(allocation?.description);
}

// A split nobody can tell was this tool's: refused unless overridden, because
// a manual split wins.
function manualSplit(allocation: Allocation | null): boolean {
  return (
    allocation?.allocationIntent === "explicit" && markerGet(allocation) === null
  );
}

function refusalGet(
  read: RolloutRead,
  override: boolean,
): string | null {
  if (!override && manualSplit(read.allocation))
    return `${read.ref.id}: a split set outside gitops (${splitDescribe(read.allocation!.targets)}). Promote with the rollout: override dispatch input to pin over it.`;
  return null;
}

async function readOne(
  api: RolloutApi,
  ref: RolloutAssistantRef,
): Promise<{ read?: RolloutRead; skip?: string; managed?: boolean }> {
  const assistant = await api.assistantGet(ref.uuid);
  if (!assistant)
    return {
      skip: `${ref.id}: not found (deleted in the dashboard?); the apply removes its mapping and publishes nothing`,
    };
  if (!assistant.latestVersion)
    return {
      skip: `${ref.id}: no published version (versioning is off), so there is nothing to ramp`,
    };
  if (assistant.managed) return { managed: true };
  return {
    read: {
      ref,
      latestVersion: assistant.latestVersion,
      allocation: await api.allocationLatestGet(ref.uuid),
    },
  };
}

// Reads every assistant and refuses, writing nothing, when any has a split set
// by hand (unless overridden) or is locked by Vapi for CX.
export async function rolloutPreflight(
  api: RolloutApi,
  org: string,
  refs: RolloutAssistantRef[],
  override: boolean,
): Promise<RolloutRead[]> {
  const reads: RolloutRead[] = [];
  const offenders: string[] = [];
  for (const ref of refs) {
    const result = await readOne(api, ref);
    if (result.skip) console.log(`  rollout skip ${result.skip}`);
    if (result.managed)
      offenders.push(
        `${ref.id}: managed by Vapi for CX, which locks its traffic allocation`,
      );
    if (!result.read) continue;
    const refusal = refusalGet(result.read, override);
    if (refusal) offenders.push(refusal);
    reads.push(result.read);
  }
  if (offenders.length > 0)
    throw new RolloutRefusal(
      `Gradual rollout into ${org} refused; nothing was promoted:\n${offenders.map((line) => `  - ${line}`).join("\n")}`,
    );
  return reads;
}

function olderLabelFirst(left: string, right: string): number {
  return (versionNumber(left) ?? 0) - (versionNumber(right) ?? 0);
}

// The version a pin holds: whatever serves now, so the publish moves nothing.
export function rolloutPinVersionGet(read: RolloutRead): string {
  const { allocation, latestVersion } = read;
  if (!allocation || allocation.allocationIntent === "follow-latest")
    return latestVersion;
  const marker = markerGet(allocation);
  if (marker?.kind === "complete" || marker?.kind === "hold")
    return marker.to ?? latestVersion;
  if (marker) return marker.from ?? latestVersion;
  // A manual split under override: the version with the most traffic, so the
  // canary never jumps to 100%. A tie goes to the older version.
  const [largest] = [...allocation.targets].sort(
    (left, right) =>
      right.percentage - left.percentage ||
      olderLabelFirst(left.assistantVersion, right.assistantVersion),
  );
  return largest?.assistantVersion ?? latestVersion;
}

function previousGet(allocation: Allocation | null): RolloutPrevious {
  if (!allocation || allocation.allocationIntent === "follow-latest")
    return "follow-latest";
  return markerGet(allocation) ? "marked" : "manual";
}

async function pinOne(
  api: RolloutApi,
  read: RolloutRead,
  override: boolean,
): Promise<RolloutPin> {
  const from = rolloutPinVersionGet(read);
  if (manualSplit(read.allocation) && override)
    console.log(
      `  rollout override ${read.ref.id}: replacing ${splitDescribe(read.allocation!.targets)} with ${from} 100%`,
    );
  const pin = await api.allocationCreate(
    {
      assistantId: read.ref.uuid,
      targets: [{ assistantVersion: from, percentage: 100 }],
      description: rolloutMarkerFormat({
        kind: "pin",
        from,
        latest: read.latestVersion,
        prev: previousGet(read.allocation),
        run: runId(),
      }),
      ...(read.allocation
        ? { expectedCurrentAllocationId: read.allocation.id }
        : {}),
    },
    "rollout-pin",
  );
  if (!read.allocation) {
    const newest = await api.allocationLatestGet(read.ref.uuid);
    if (newest?.id !== pin.id)
      throw new RolloutNotOurs(`${read.ref.id}: another write landed with the pin`);
  }
  return { read, from, pin, replaced: read.allocation };
}

function retryable(error: unknown): boolean {
  if (error instanceof RolloutNotOurs) return true;
  if (allocationConflictGet(error) === "stale_allocation") return true;
  return error instanceof VapiApiError && error.statusCode >= 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function rolloutRestoreWrite(pin: RolloutPin): AllocationWrite {
  const replaced = pin.replaced;
  const description = replaced?.description
    ? { description: replaced.description }
    : {};
  if (!replaced || replaced.allocationIntent === "follow-latest")
    return {
      assistantId: pin.read.ref.uuid,
      allocationIntent: "follow-latest",
      ...description,
      expectedCurrentAllocationId: pin.pin.id,
    };
  return {
    assistantId: pin.read.ref.uuid,
    targets: replaced.targets.map((target) => ({
      assistantVersion: target.assistantVersion,
      percentage: target.percentage,
    })),
    ...description,
    expectedCurrentAllocationId: pin.pin.id,
  };
}

async function restoreAll(api: RolloutApi, pins: RolloutPin[]): Promise<string[]> {
  const failures: string[] = [];
  for (const pin of pins)
    await api
      .allocationCreate(rolloutRestoreWrite(pin), "rollout-restore")
      .catch((error: unknown) =>
        failures.push(
          `${pin.read.ref.id}: couldn't undo its pin (${messageOf(error)})`,
        ),
      );
  return failures;
}

// Pins every assistant, or none: on a failure that a fresh read and one
// retry don't clear, the pins already written are undone and nothing is
// published.
export async function rolloutPinAll(
  api: RolloutApi,
  org: string,
  reads: RolloutRead[],
  override: boolean,
): Promise<RolloutPin[]> {
  const pins: RolloutPin[] = [];
  for (const read of reads) {
    try {
      pins.push(await pinOne(api, read, override));
      continue;
    } catch (error) {
      if (!retryable(error))
        return rolloutPinAbandon(api, org, pins, messageOf(error));
    }
    const fresh = await readOne(api, read.ref).catch((error: unknown) => ({
      error: messageOf(error),
    }));
    if ("error" in fresh || !fresh.read)
      return rolloutPinAbandon(
        api,
        org,
        pins,
        "error" in fresh
          ? fresh.error
          : `${read.ref.id}: ${fresh.skip ?? "managed by Vapi for CX"}`,
      );
    const refusal = refusalGet(fresh.read, override);
    if (refusal) return rolloutPinAbandon(api, org, pins, refusal);
    try {
      pins.push(await pinOne(api, fresh.read, override));
    } catch (error) {
      return rolloutPinAbandon(api, org, pins, messageOf(error));
    }
  }
  return pins;
}

async function rolloutPinAbandon(
  api: RolloutApi,
  org: string,
  pins: RolloutPin[],
  reason: string,
): Promise<never> {
  const failures = await restoreAll(api, pins);
  throw new RolloutRefusal(
    [
      `Gradual rollout into ${org} stopped before publishing: ${reason}`,
      ...failures,
    ].join("\n"),
  );
}

export function rolloutStepTargets(
  from: string,
  to: string,
  percent: number,
): AllocationTarget[] {
  const share = millipercentage(percent);
  return [
    { assistantVersion: from, percentage: (100_000 - share) / 1000 },
    { assistantVersion: to, percentage: share / 1000 },
  ];
}

function sameWrite(allocation: Allocation | null, write: AllocationWrite): boolean {
  if (!allocation) return false;
  const marker = markerGet(allocation);
  const intended = rolloutMarkerParse(write.description);
  return (
    marker?.kind === intended?.kind &&
    marker?.from === intended?.from &&
    marker?.to === intended?.to &&
    JSON.stringify(allocation.targets) === JSON.stringify(write.targets ?? [])
  );
}

export interface RolloutFinishArgs {
  api: RolloutApi;
  pins: RolloutPin[];
  steps: number[];
  childFailed: boolean;
}

// After the apply child, successful or not: step 1 where a new version was
// published, the undo where nothing was. Returns per-assistant failures.
export async function rolloutFinish(args: RolloutFinishArgs): Promise<string[]> {
  const { api, pins, steps, childFailed } = args;
  const failures: string[] = [];
  for (const pin of pins) {
    const { ref } = pin.read;
    try {
      const assistant = await api.assistantGet(ref.uuid);
      const latest = assistant?.latestVersion ?? null;
      const published = latest !== null && latest !== pin.read.latestVersion;
      const write: AllocationWrite = published
        ? {
            assistantId: ref.uuid,
            targets: rolloutStepTargets(pin.from, latest, steps[0]!),
            description: rolloutMarkerFormat({
              kind: "step",
              from: pin.from,
              to: latest,
              step: 1,
              steps: steps.length,
              run: runId(),
            }),
            expectedCurrentAllocationId: pin.pin.id,
          }
        : rolloutRestoreWrite(pin);
      if (published && childFailed)
        console.warn(
          `  rollout ${ref.id}: ${latest} was published while the apply failed; it may be a dashboard publish rather than this promotion's`,
        );
      try {
        await api.allocationCreate(write, published ? "rollout-step" : "rollout-restore");
        console.log(
          published
            ? `  rollout ${ref.id}: ${pin.from} → ${latest} at ${steps[0]}%`
            : `  rollout ${ref.id}: nothing published, pin undone`,
        );
      } catch (error) {
        if (allocationConflictGet(error) !== "stale_allocation") throw error;
        const newest = await api.allocationLatestGet(ref.uuid);
        if (markerGet(newest)?.kind === "abort") {
          console.log(`  rollout ${ref.id}: aborted meanwhile; left aborted`);
          continue;
        }
        if (!sameWrite(newest, write)) throw error;
      }
    } catch (error) {
      failures.push(`${ref.id}: ${messageOf(error)}`);
    }
  }
  return failures;
}

// latestVersion for each assistant, skipping any that can't be read: the
// unpinned-publish report is advice, so it never fails a run.
export async function rolloutSnapshot(
  api: RolloutApi,
  refs: RolloutAssistantRef[],
): Promise<Map<string, string | null>> {
  const snapshot = new Map<string, string | null>();
  for (const ref of refs)
    try {
      const assistant = await api.assistantGet(ref.uuid);
      if (assistant) snapshot.set(ref.uuid, assistant.latestVersion);
    } catch (error) {
      console.warn(`  rollout ${ref.id}: couldn't read its version (${messageOf(error)})`);
    }
  return snapshot;
}

// Assistants the apply published without a pin (a squad member it re-applied,
// say), which went live at 100%.
export async function rolloutUnpinnedReport(
  api: RolloutApi,
  refs: RolloutAssistantRef[],
  before: Map<string, string | null>,
): Promise<void> {
  const after = await rolloutSnapshot(
    api,
    refs.filter((ref) => before.has(ref.uuid)),
  );
  for (const ref of refs) {
    const was = before.get(ref.uuid);
    const now = after.get(ref.uuid);
    if (before.has(ref.uuid) && after.has(ref.uuid) && was !== now)
      console.warn(
        `  rollout ${ref.id}: published ${now} without a pin, so it went live at 100%`,
      );
  }
}

// --no-rollout: after the child, a gitops-held assistant whose new version
// was published goes back to follow-latest, so a revert goes live at once.
export async function rolloutRelease(
  api: RolloutApi,
  refs: RolloutAssistantRef[],
  before: Map<string, string | null>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const ref of refs) {
    if (!before.has(ref.uuid)) continue;
    try {
      const assistant = await api.assistantGet(ref.uuid);
      const latest = assistant?.latestVersion ?? null;
      if (!latest || latest === before.get(ref.uuid)) continue;
      const allocation = await api.allocationLatestGet(ref.uuid);
      if (allocation?.allocationIntent !== "explicit") continue;
      if (!markerGet(allocation)) {
        console.warn(
          `  rollout ${ref.id}: kept the split set outside gitops (${splitDescribe(allocation.targets)}); ${latest} was published at 0%`,
        );
        continue;
      }
      await api.allocationCreate(
        {
          assistantId: ref.uuid,
          allocationIntent: "follow-latest",
          description: rolloutMarkerFormat({ kind: "release", run: runId() }),
          expectedCurrentAllocationId: allocation.id,
        },
        "rollout-release",
      );
      console.log(`  rollout ${ref.id}: released; ${latest} takes every call`);
    } catch (error) {
      failures.push(`${ref.id}: ${messageOf(error)}`);
    }
  }
  return failures;
}

// latestVersion before the child, for --no-rollout; 404s and assistants
// without versions are left out, as preflight skips them.
export async function rolloutReleaseBaseline(
  api: RolloutApi,
  refs: RolloutAssistantRef[],
): Promise<Map<string, string | null>> {
  const baseline = new Map<string, string | null>();
  for (const ref of refs) {
    const assistant = await api.assistantGet(ref.uuid);
    if (assistant?.latestVersion) baseline.set(ref.uuid, assistant.latestVersion);
  }
  return baseline;
}
