import { VAPI_ENV } from "./config.ts";
import type { RemoteResource } from "./dep-dedup.ts";
import { prepareResourceLinks } from "./link-preflight.ts";
import { fetchAllResources } from "./pull.ts";
import { loadResources } from "./resources.ts";
import { loadState } from "./state.ts";
import type { TouchedSets } from "./state-merge.ts";
import { formatStopReport, jsonStopReport } from "./stop-report.ts";
import { type LoadedResources, VALID_RESOURCE_TYPES } from "./types.ts";

export async function preflightApplyLinks(
  output: (value: string) => void,
): Promise<void> {
  const state = loadState();
  const resources = Object.fromEntries(
    await Promise.all(
      VALID_RESOURCE_TYPES.map(async (type) => [
        type,
        await loadResources(type, { quiet: true }),
      ]),
    ),
  ) as unknown as LoadedResources;
  const touched = Object.fromEntries(
    ["credentials", ...VALID_RESOURCE_TYPES].map((type) => [
      type,
      new Set<string>(),
    ]),
  ) as unknown as TouchedSets;
  const inventories = new Map<string, Promise<RemoteResource[]>>();
  const links = await prepareResourceLinks({
    state,
    resources,
    touched,
    getRemoteList: (type) => {
      let inventory = inventories.get(type);
      if (!inventory) {
        inventory = fetchAllResources(type) as Promise<RemoteResource[]>;
        inventories.set(type, inventory);
      }
      return inventory;
    },
  });
  if (links.issues.length) {
    if (process.argv.includes("--json")) output(jsonStopReport(links.issues));
    else console.error(formatStopReport(links.issues, VAPI_ENV));
    process.exit(1);
  }
}
