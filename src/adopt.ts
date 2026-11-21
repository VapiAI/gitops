import { extractResourceName, type RemoteResource } from "./dep-dedup.ts";
import { extractBaseSlug, slugify } from "./slug-utils.ts";
import type { TouchedSets } from "./state-merge.ts";
import type { LoadedResources, ResourceType, StateFile } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

export interface AdoptionAlias {
  type: ResourceType;
  resourceId: string;
  uuid: string;
  adoptedAs: string;
}

export function parseAdoptArgs(args: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--adopt" && !arg.startsWith("--adopt=")) continue;
    const target = arg === "--adopt" ? args[++i] : arg.slice("--adopt=".length);
    if (
      !target ||
      target.startsWith("--") ||
      !/^[^=\s]+(?:=[^=\s]+)?$/.test(target)
    ) {
      throw new Error("--adopt requires <resourceId> or <resourceId>=<uuid>");
    }
    targets.push(target);
  }
  return targets;
}

export async function adoptResources(opts: {
  targets: string[];
  resources: LoadedResources;
  state: StateFile;
  touched: TouchedSets;
  getRemoteList: (type: ResourceType) => Promise<RemoteResource[]>;
  dryRun: boolean;
  errors?: { target: string; message: string }[];
  quiet?: boolean;
  cleanupAliases?: (aliases: AdoptionAlias[]) => Promise<void>;
}): Promise<StateFile> {
  const state = opts.dryRun ? structuredClone(opts.state) : opts.state;
  const plans: { type: ResourceType; resourceId: string; uuid: string }[] = [];
  const inventories = new Map<ResourceType, RemoteResource[]>();
  for (const target of opts.targets) {
    try {
      const [resourceId, requestedUuid] = target.split("=") as [
        string,
        string?,
      ];
      const files = VALID_RESOURCE_TYPES.flatMap((type) =>
        opts.resources[type]
          .filter((r) => r.resourceId === resourceId)
          .map((resource) => ({ type, resource })),
      );
      if (!files.length) throw new Error(`--adopt ${resourceId}: no such file`);
      if (files.length !== 1)
        throw new Error(
          `--adopt ${resourceId}: file ID exists in multiple resource types`,
        );
      const { type, resource } = files[0]!;
      if (state[type][resourceId])
        throw new Error(`--adopt ${resourceId}: already linked`);
      let remote = inventories.get(type);
      if (!remote) {
        remote = await opts.getRemoteList(type);
        inventories.set(type, remote);
      }
      const candidates = new Set<string>();
      for (const [key, entry] of Object.entries(state[type])) {
        if (extractBaseSlug(key) === resourceId) candidates.add(entry.uuid);
      }
      const name = slugify(extractResourceName(resource.data) ?? resourceId);
      for (const entry of remote) {
        if (slugify(extractResourceName(entry) ?? "") === name)
          candidates.add(entry.id);
      }
      let uuid = requestedUuid;
      if (uuid) {
        if (!remote.some((entry) => entry.id === uuid)) {
          throw new Error(
            `--adopt ${resourceId}=${uuid}: UUID does not exist remotely for ${type}`,
          );
        }
      } else {
        if (!candidates.size)
          throw new Error(`--adopt ${resourceId}: no candidates`);
        if (candidates.size !== 1) {
          throw new Error(
            `--adopt ${resourceId}: ambiguous candidates: ${[...candidates].sort().join(", ")}. Use --adopt ${resourceId}=<uuid>`,
          );
        }
        uuid = [...candidates][0]!;
      }
      if (
        plans.some(
          (p) =>
            p.type === type && (p.resourceId === resourceId || p.uuid === uuid),
        )
      ) {
        throw new Error(
          `--adopt ${resourceId}: duplicate adoption target or UUID`,
        );
      }
      plans.push({ type, resourceId, uuid });
    } catch (error) {
      if (!opts.errors) throw error;
      opts.errors.push({
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const aliases = plans.flatMap(({ type, resourceId, uuid }) =>
    Object.entries(state[type])
      .filter(([key, entry]) => key !== resourceId && entry.uuid === uuid)
      .map(([key]) => ({ type, resourceId: key, uuid, adoptedAs: resourceId })),
  );
  await opts.cleanupAliases?.(aliases);
  for (const { type, resourceId, uuid } of plans) {
    if (!opts.quiet)
      console.log(
        `  ${opts.dryRun ? "would adopt" : "Adopting"} ${resourceId} → ${uuid}`,
      );
    state[type][resourceId] = { uuid, origin: "adopted" };
    if (!opts.dryRun) opts.touched[type].add(resourceId);
    for (const [key, entry] of Object.entries(state[type])) {
      if (key !== resourceId && entry.uuid === uuid) {
        delete state[type][key];
        if (!opts.dryRun) opts.touched[type].add(key);
      }
    }
  }
  return state;
}
