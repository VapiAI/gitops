import type { AdoptionAlias } from "./adopt.ts";
import { cleanupAdoptionAliases } from "./adopt-alias-files.ts";
import { loadResources } from "./resources.ts";
import { extractBaseSlug } from "./slug-utils.ts";
import { loadState } from "./state.ts";
import { type LoadedResources, VALID_RESOURCE_TYPES } from "./types.ts";

export async function preflightApplyAliases(targets: string[]): Promise<void> {
  const state = loadState();
  const resources = Object.fromEntries(
    await Promise.all(
      VALID_RESOURCE_TYPES.map(async (type) => [
        type,
        await loadResources(type, { quiet: true }),
      ]),
    ),
  ) as unknown as LoadedResources;
  const aliases: AdoptionAlias[] = [];
  for (const target of targets) {
    const [adoptedAs, requestedUuid] = target.split("=") as [string, string?];
    for (const type of VALID_RESOURCE_TYPES) {
      if (!resources[type].some((file) => file.resourceId === adoptedAs))
        continue;
      const uuids = new Set(
        Object.entries(state[type])
          .filter(([key, entry]) =>
            requestedUuid
              ? entry.uuid === requestedUuid
              : extractBaseSlug(key) === adoptedAs,
          )
          .map(([, entry]) => entry.uuid),
      );
      for (const [resourceId, { uuid }] of Object.entries(state[type])) {
        if (resourceId !== adoptedAs && uuids.has(uuid))
          aliases.push({ type, resourceId, uuid, adoptedAs });
      }
    }
  }
  await cleanupAdoptionAliases(aliases, resources, true);
}
