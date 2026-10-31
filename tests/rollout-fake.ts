// An in-memory stand-in for the traffic-allocation API, with the platform's
// semantics: append-only allocations, compare-and-set writes, and the
// publish-time rule (a publish under follow-latest or no allocation appends a
// system follow-latest row; under an explicit split it appends nothing, so
// the new version lands at 0%).

import type {
  Allocation,
  AllocationWrite,
  RolloutApi,
  RolloutAssistant,
} from "../src/rollout-api.ts";
import type { RolloutCommand } from "../src/user-agent.ts";
import { VapiApiError } from "../src/vapi-client.ts";

export interface FakeWrite {
  command: RolloutCommand | "system" | "manual";
  allocation: Allocation;
}

export class RolloutFake {
  assistants = new Map<string, RolloutAssistant>();
  history = new Map<string, Allocation[]>();
  writes: FakeWrite[] = [];
  splittingEnabled = true;
  probes = 0;
  reads = 0;
  // Fails the Nth allocationCreate (1-based) with this status and body.
  failCreate?: { nth: number; status: number; error: string };
  // Runs before each allocationCreate, to simulate a concurrent writer.
  beforeCreate?: (write: AllocationWrite) => void;
  private creates = 0;
  private clock = Date.parse("2026-10-30T12:00:00Z");
  private ids = 0;

  assistantAdd(id: string, latestVersion: string | null, managed = false) {
    this.assistants.set(id, { latestVersion, managed });
  }

  latest(assistantId: string): Allocation | null {
    const rows = this.history.get(assistantId) ?? [];
    return rows[rows.length - 1] ?? null;
  }

  // Moves the clock, so createdAt-based intervals can elapse.
  advance(minutes: number) {
    this.clock += minutes * 60_000;
  }

  // A write made outside gitops (the dashboard, another tool).
  manualWrite(write: AllocationWrite) {
    this.append(write, "manual");
  }

  publish(assistantId: string, version: string) {
    const assistant = this.assistants.get(assistantId)!;
    assistant.latestVersion = version;
    const latest = this.latest(assistantId);
    if (!latest || latest.allocationIntent === "follow-latest")
      this.append({ assistantId, allocationIntent: "follow-latest" }, "system");
  }

  private append(write: AllocationWrite, command: FakeWrite["command"]) {
    const explicit = write.targets !== undefined;
    const allocation: Allocation = {
      id: `alloc-${++this.ids}`,
      assistantId: write.assistantId,
      allocationIntent: explicit ? "explicit" : "follow-latest",
      createdAt: new Date(this.clock).toISOString(),
      ...(write.description ? { description: write.description } : {}),
      targets: (write.targets ?? []).map((target) => ({ ...target })),
    };
    const rows = this.history.get(write.assistantId) ?? [];
    rows.push(allocation);
    this.history.set(write.assistantId, rows);
    this.writes.push({ command, allocation });
    return allocation;
  }

  api(): RolloutApi {
    return {
      assistantGet: async (id) => {
        this.reads++;
        const assistant = this.assistants.get(id);
        return assistant ? { ...assistant } : null;
      },
      allocationLatestGet: async (id) => {
        this.reads++;
        const latest = this.latest(id);
        return latest ? structuredClone(latest) : null;
      },
      allocationCreate: async (write, command) => {
        this.creates++;
        this.beforeCreate?.(write);
        if (this.failCreate?.nth === this.creates)
          throw new VapiApiError(
            "POST",
            "/traffic-allocations",
            this.failCreate.status,
            this.failCreate.error,
            JSON.stringify({ error: this.failCreate.error }),
          );
        if (this.assistants.get(write.assistantId)?.managed)
          throw new VapiApiError(
            "POST",
            "/traffic-allocations",
            409,
            "managed",
            JSON.stringify({ error: "assistant_managed_by_vapi_agents" }),
          );
        const current = this.latest(write.assistantId)?.id;
        if (
          write.expectedCurrentAllocationId !== undefined &&
          write.expectedCurrentAllocationId !== current
        )
          throw new VapiApiError(
            "POST",
            "/traffic-allocations",
            409,
            "stale",
            JSON.stringify({
              error: "stale_allocation",
              currentAllocationId: current ?? null,
            }),
          );
        return structuredClone(this.append(write, command));
      },
      allocationsProbe: async () => {
        this.probes++;
        return this.splittingEnabled;
      },
    };
  }
}
