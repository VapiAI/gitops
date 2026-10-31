// What the rollout ticker does next for one assistant, decided from its
// newest traffic allocation alone. Pure, so every row of the decision table
// is tested without an API.

import type { PromotionRollout } from "./promotion.ts";
import type {
  Allocation,
  AllocationWrite,
  RolloutVersionHealth,
} from "./rollout-api.ts";
import type { RolloutMarker } from "./rollout-marker.ts";
import { rolloutMarkerFormat, rolloutMarkerParse } from "./rollout-marker.ts";
import { rolloutStepTargets } from "./rollout-promote.ts";
import type { RolloutCommand } from "./user-agent.ts";

// How old a pin must be before the ticker treats it as left behind by a
// killed promotion. Pins exist only inside the promotion step, which
// .github/workflows/promotion.yml caps at 330 minutes (a test ties the two),
// so no running promotion owns a pin older than this. Holds only in CI: a
// local promote has no cap.
export const ROLLOUT_ORPHAN_AGE_MINUTES = 360;

export interface RolloutTickInput {
  assistantId: string;
  allocation: Allocation | null;
  latestVersion: string | null;
  rollout: PromotionRollout;
  now: number;
  runId?: string;
  // Calls since the current step, per version; only with a health gate.
  health?: RolloutVersionHealth[];
}

export interface RolloutTickWrite {
  command: RolloutCommand;
  write: AllocationWrite;
  // One line for the run's output.
  summary: string;
}

export interface RolloutTickDecision {
  write?: RolloutTickWrite;
  // A reason the ramp is waiting or stopped, for `status` and the log.
  note?: string;
  // A ramp a human should look at.
  stale?: boolean;
}

function ageMinutes(allocation: Allocation, now: number): number {
  return (now - Date.parse(allocation.createdAt)) / 60_000;
}

function stepWrite(
  input: RolloutTickInput,
  from: string,
  to: string,
  step: number,
): RolloutTickWrite {
  const { steps } = input.rollout;
  const percent = steps[step - 1]!;
  return {
    command: "rollout-step",
    write: {
      assistantId: input.assistantId,
      targets: rolloutStepTargets(from, to, percent),
      description: rolloutMarkerFormat({
        kind: "step",
        from,
        to,
        step,
        steps: steps.length,
        run: input.runId,
      }),
      expectedCurrentAllocationId: input.allocation!.id,
    },
    summary: `${from} → ${to} at ${percent}% (step ${step}/${steps.length})`,
  };
}

function stepNext(
  input: RolloutTickInput,
  marker: RolloutMarker,
): RolloutTickDecision {
  const allocation = input.allocation!;
  const { steps, intervalMinutes } = input.rollout;
  if (!marker.from || !marker.to || marker.step === undefined)
    return { note: "step without from/to; left alone", stale: true };
  const age = ageMinutes(allocation, input.now);
  if (age < intervalMinutes)
    return {
      note: `step ${marker.step}/${steps.length} at ${marker.to}; next in ${Math.ceil(intervalMinutes - age)} min`,
    };
  const gated = healthGateCheck(input, marker);
  if (gated) return gated;
  // The last step (100%) is written as `complete`, not as a 0/100 split.
  if (marker.step + 1 < steps.length)
    return { write: stepWrite(input, marker.from, marker.to, marker.step + 1) };
  return {
    write: {
      command: "rollout-complete",
      write: {
        assistantId: input.assistantId,
        targets: [{ assistantVersion: marker.to, percentage: 100 }],
        description: rolloutMarkerFormat({
          kind: "complete",
          from: marker.from,
          to: marker.to,
          run: input.runId,
        }),
        expectedCurrentAllocationId: allocation.id,
      },
      summary: `${marker.to} at 100%, ramp complete`,
    },
  };
}

function releaseWrite(
  input: RolloutTickInput,
  summary: string,
): RolloutTickWrite {
  return {
    command: "rollout-release",
    write: {
      assistantId: input.assistantId,
      allocationIntent: "follow-latest",
      description: rolloutMarkerFormat({ kind: "release", run: input.runId }),
      expectedCurrentAllocationId: input.allocation!.id,
    },
    summary,
  };
}

// A complete ramp hands back to follow-latest, unless a newer version was
// published meanwhile: follow-latest would send it every call un-ramped.
function completeNext(
  input: RolloutTickInput,
  marker: RolloutMarker,
): RolloutTickDecision {
  if (!marker.to || input.latestVersion === marker.to)
    return { write: releaseWrite(input, "released to follow-latest") };
  return {
    write: {
      command: "rollout-hold",
      write: {
        assistantId: input.assistantId,
        targets: [{ assistantVersion: marker.to, percentage: 100 }],
        description: rolloutMarkerFormat({
          kind: "hold",
          from: marker.from,
          to: marker.to,
          hold: input.latestVersion ?? undefined,
          run: input.runId,
        }),
        expectedCurrentAllocationId: input.allocation!.id,
      },
      summary: `held on ${marker.to}: ${input.latestVersion} was published during the ramp and has not been ramped; promote again to ramp it`,
    },
  };
}

function pinNext(
  input: RolloutTickInput,
  marker: RolloutMarker,
): RolloutTickDecision {
  const age = ageMinutes(input.allocation!, input.now);
  if (age < ROLLOUT_ORPHAN_AGE_MINUTES)
    return { note: "pinned by a promotion that may still be running" };
  // The killed run published: carry its ramp on from step 1.
  if (
    marker.from &&
    input.latestVersion &&
    input.latestVersion !== marker.latest
  )
    return { write: stepWrite(input, marker.from, input.latestVersion, 1) };
  // It was killed before publishing: undo the pin if it replaced the default.
  if (marker.prev === "follow-latest")
    return {
      write: releaseWrite(input, "a stale pin from a killed promotion, released"),
    };
  return {
    note: `pinned on ${marker.from} by a promotion that stopped before publishing; promote again, or abort`,
    stale: true,
  };
}

function errorRate(health: RolloutVersionHealth | undefined): number {
  if (!health || health.calls === 0) return 0;
  return (health.errors / health.calls) * 100;
}

// Before a step moves on: wait for enough calls on the new version, then
// abort if its error rate is too far above the old version's.
function healthGateCheck(
  input: RolloutTickInput,
  marker: RolloutMarker,
): RolloutTickDecision | null {
  const gate = input.rollout.healthGate;
  if (!gate) return null;
  const health = input.health ?? [];
  const to = health.find((version) => version.version === marker.to);
  const from = health.find((version) => version.version === marker.from);
  const calls = to?.calls ?? 0;
  if (calls < gate.minCalls)
    return {
      note: `step ${marker.step} at ${marker.to}: ${calls} of ${gate.minCalls} calls before the next step`,
    };
  const delta = errorRate(to) - errorRate(from);
  if (delta <= gate.maxErrorRateDelta) return null;
  const reason = `error-rate+${delta.toFixed(1)}pp`;
  const abort = rolloutAbortWrite(
    input.assistantId,
    input.allocation,
    input.runId,
    reason,
  );
  if (!abort) return null;
  return {
    write: {
      ...abort,
      summary: `aborted by the health gate: ${marker.to}'s error rate is ${delta.toFixed(1)} points above ${marker.from}'s`,
    },
  };
}

export function rolloutTickDecide(input: RolloutTickInput): RolloutTickDecision {
  const marker = rolloutMarkerParse(input.allocation?.description);
  if (!input.allocation || !marker) return {};
  if (marker.kind === "step") return stepNext(input, marker);
  if (marker.kind === "complete") return completeNext(input, marker);
  if (marker.kind === "pin") return pinNext(input, marker);
  if (marker.kind === "hold")
    return {
      note: `held on ${marker.to}; ${marker.hold} has not been ramped`,
      stale: true,
    };
  if (marker.kind === "abort")
    return {
      note: `aborted at ${marker.from} 100%; new publishes land at 0% until the next promotion`,
    };
  return {};
}

// The abort write for an active ramp, or null when there is nothing to abort.
export function rolloutAbortWrite(
  assistantId: string,
  allocation: Allocation | null,
  runId?: string,
  reason?: string,
): RolloutTickWrite | null {
  const marker = rolloutMarkerParse(allocation?.description);
  if (!allocation || !marker) return null;
  if (
    marker.kind !== "step" &&
    marker.kind !== "complete" &&
    marker.kind !== "hold"
  )
    return null;
  if (!marker.from) return null;
  return {
    command: "rollout-abort",
    write: {
      assistantId,
      targets: [{ assistantVersion: marker.from, percentage: 100 }],
      description: rolloutMarkerFormat({
        kind: "abort",
        from: marker.from,
        to: marker.to,
        step: marker.step,
        steps: marker.steps,
        reason,
        run: runId,
      }),
      expectedCurrentAllocationId: allocation.id,
    },
    summary: `aborted: ${marker.from} back to 100%`,
  };
}
