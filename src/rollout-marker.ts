// The marker a gradual rollout writes into each traffic allocation's
// description. The allocations are the rollout's only state: the ticker reads
// the newest one per assistant and decides the next step from its marker, so
// nothing about a ramp is committed to git.
//
//   gitops-rollout <kind> [from=vN] [to=vM] [step=i/K] [latest=vX]
//                         [prev=follow-latest|marked|manual] [hold=vK]
//                         [reason=<token>] [run=<id>]

export type RolloutMarkerKind =
  | "pin"
  | "step"
  | "complete"
  | "hold"
  | "abort"
  | "release";

// What a pin replaced: the default (follow-latest or nothing), a row this
// tool wrote, or a split someone made by hand.
export type RolloutPrevious = "follow-latest" | "marked" | "manual";

export interface RolloutMarker {
  kind: RolloutMarkerKind;
  // The version the ramp moves traffic away from.
  from?: string;
  // The version the ramp moves traffic to.
  to?: string;
  // 1-based step number and the number of steps.
  step?: number;
  steps?: number;
  // A pin's latestVersion when it was written; a different latestVersion
  // later means the run that wrote the pin published.
  latest?: string;
  prev?: RolloutPrevious;
  // A newer, un-ramped version that kept a complete ramp from releasing.
  hold?: string;
  // Why the health gate aborted, as one token (e.g. error-rate+4.1pp).
  reason?: string;
  run?: string;
}

const PREFIX = "gitops-rollout";
const KINDS: RolloutMarkerKind[] = [
  "pin",
  "step",
  "complete",
  "hold",
  "abort",
  "release",
];
const PREVIOUS: RolloutPrevious[] = ["follow-latest", "marked", "manual"];

export function rolloutMarkerFormat(marker: RolloutMarker): string {
  const fields: string[] = [PREFIX, marker.kind];
  if (marker.from) fields.push(`from=${marker.from}`);
  if (marker.to) fields.push(`to=${marker.to}`);
  if (marker.step !== undefined && marker.steps !== undefined)
    fields.push(`step=${marker.step}/${marker.steps}`);
  if (marker.latest) fields.push(`latest=${marker.latest}`);
  if (marker.prev) fields.push(`prev=${marker.prev}`);
  if (marker.hold) fields.push(`hold=${marker.hold}`);
  if (marker.reason) fields.push(`reason=${marker.reason}`);
  if (marker.run) fields.push(`run=${marker.run}`);
  return fields.join(" ");
}

// null for a description this tool didn't write (or none at all).
export function rolloutMarkerParse(
  description: string | undefined,
): RolloutMarker | null {
  const [prefix, kind, ...fields] = (description ?? "").trim().split(/\s+/);
  if (prefix !== PREFIX || !KINDS.includes(kind as RolloutMarkerKind))
    return null;
  const marker: RolloutMarker = { kind: kind as RolloutMarkerKind };
  for (const field of fields) {
    const equals = field.indexOf("=");
    if (equals <= 0) continue;
    const key = field.slice(0, equals);
    const value = field.slice(equals + 1);
    if (key === "from") marker.from = value;
    if (key === "to") marker.to = value;
    if (key === "latest") marker.latest = value;
    if (key === "hold") marker.hold = value;
    if (key === "reason") marker.reason = value;
    if (key === "run") marker.run = value;
    if (key === "prev" && PREVIOUS.includes(value as RolloutPrevious))
      marker.prev = value as RolloutPrevious;
    if (key === "step") {
      const match = /^(\d+)\/(\d+)$/.exec(value);
      if (match) {
        marker.step = Number(match[1]);
        marker.steps = Number(match[2]);
      }
    }
  }
  return marker;
}

// The N of a "vN" label, or null for any other label.
export function versionNumber(label: string): number | null {
  const match = /^v(\d+)$/.exec(label);
  return match ? Number(match[1]) : null;
}
