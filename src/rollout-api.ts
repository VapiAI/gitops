// The traffic-allocation calls a gradual rollout makes, against one org.
// Config-free (like vapi-client.ts) because promotion and the rollout ticker
// both work with several orgs in one process.

import type { OrgConnection } from "./org-connection.ts";
import type { RolloutCommand } from "./user-agent.ts";
import { userAgentGet, vapiClientGet } from "./user-agent.ts";
import type { VapiConnection } from "./vapi-client.ts";
import {
  DEFAULT_BASE_URL,
  VapiApiError,
  vapiFetchJson,
} from "./vapi-client.ts";

export interface AllocationTarget {
  // A published version label, such as "v7".
  assistantVersion: string;
  // Decimal percent with at most three decimal places.
  percentage: number;
}

// GET /traffic-allocations/latest's allocation. Follow-latest rows carry no
// targets: every call goes to the newest published version.
export interface Allocation {
  id: string;
  assistantId: string;
  allocationIntent: "explicit" | "follow-latest";
  createdAt: string;
  description?: string;
  targets: AllocationTarget[];
}

// POST /traffic-allocations. Allocations are append-only: a write replaces
// the one in effect. expectedCurrentAllocationId makes it a compare-and-set
// (409 stale_allocation when another write landed first); omitted, it never
// conflicts.
export interface AllocationWrite {
  assistantId: string;
  allocationIntent?: "explicit" | "follow-latest";
  targets?: AllocationTarget[];
  description?: string;
  expectedCurrentAllocationId?: string;
}

export interface RolloutAssistant {
  // The newest published version label; null when versioning is off.
  latestVersion: string | null;
  // Vapi for CX manages it, so the API refuses allocation writes with a 409.
  managed: boolean;
}

// Why a write was refused with 409, from the response body's `error`.
export type AllocationConflict =
  | "stale_allocation"
  | "assistant_managed_by_vapi_agents"
  | "other";

export interface RolloutApi {
  // null when the assistant no longer exists (deleted in the dashboard).
  assistantGet(assistantId: string): Promise<RolloutAssistant | null>;
  // null when traffic splitting was never configured for the assistant.
  allocationLatestGet(assistantId: string): Promise<Allocation | null>;
  allocationCreate(
    write: AllocationWrite,
    command: RolloutCommand,
  ): Promise<Allocation>;
  // false when traffic splitting is not enabled for the org (a beta flag).
  allocationsProbe(): Promise<boolean>;
}

// The platform's test for an assistant managed by Vapi for CX: a UUID in
// metadata.vapiAgentId. Anything else there isn't a lock.
const VAPI_AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AssistantResponse {
  latestVersion?: string | null;
  metadata?: { vapiAgentId?: unknown } | null;
}

interface AllocationLatestResponse {
  allocation?: Allocation;
}

function notFound(error: unknown): boolean {
  return error instanceof VapiApiError && error.statusCode === 404;
}

export function allocationConflictGet(
  error: unknown,
): AllocationConflict | null {
  if (!(error instanceof VapiApiError) || error.statusCode !== 409) return null;
  try {
    const code: unknown = JSON.parse(error.rawBody)?.error;
    if (
      code === "stale_allocation" ||
      code === "assistant_managed_by_vapi_agents"
    )
      return code;
  } catch {
    /* not JSON: an unrecognized conflict */
  }
  return "other";
}

// Reads retry 429 and 5xx. Writes retry only 429: a 5xx may come after the
// write committed, and a blind retry would then 409 against its own write.
export function rolloutApiCreate(connection: OrgConnection): RolloutApi {
  const base = {
    token: connection.token,
    baseUrl: connection.baseUrl ?? DEFAULT_BASE_URL,
    userAgent: userAgentGet(),
  };
  const reads: VapiConnection = { ...base, vapiClient: vapiClientGet() };
  return {
    async assistantGet(assistantId) {
      try {
        const assistant = await vapiFetchJson<AssistantResponse>(
          reads,
          "GET",
          `/assistant/${encodeURIComponent(assistantId)}`,
        );
        const agentId = assistant.metadata?.vapiAgentId;
        return {
          latestVersion: assistant.latestVersion ?? null,
          managed:
            typeof agentId === "string" && VAPI_AGENT_ID_PATTERN.test(agentId),
        };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async allocationLatestGet(assistantId) {
      const response = await vapiFetchJson<AllocationLatestResponse>(
        reads,
        "GET",
        `/traffic-allocations/latest?assistantId=${encodeURIComponent(assistantId)}`,
      );
      return response.allocation ?? null;
    },
    allocationCreate(write, command) {
      const writes: VapiConnection = {
        ...base,
        vapiClient: vapiClientGet(command),
      };
      return vapiFetchJson<Allocation>(
        writes,
        "POST",
        "/traffic-allocations",
        write,
        { retry: "rate-limit-only" },
      );
    },
    async allocationsProbe() {
      try {
        await vapiFetchJson<unknown>(
          reads,
          "GET",
          "/traffic-allocations?limit=1",
        );
        return true;
      } catch (error) {
        if (error instanceof VapiApiError && error.statusCode === 403)
          return false;
        throw error;
      }
    },
  };
}
