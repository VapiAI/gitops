import {
  extractResourceName,
  type NameablePayload,
  type RemoteResource,
} from "./dep-dedup.ts";
import { extractBaseSlug, slugify } from "./slug-utils.ts";
import type { ResourceState, ResourceType } from "./types.ts";

export class NameCollisionReport {
  private inventories = new Map<ResourceType, Promise<RemoteResource[]>>();
  private posts = new Map<
    string,
    {
      type: ResourceType;
      resourceId: string;
      name: string;
      stateMatches: RemoteResource[];
    }
  >();

  constructor(
    private fetchRemote: (type: ResourceType) => Promise<RemoteResource[]>,
  ) {}

  getRemoteList(type: ResourceType): Promise<RemoteResource[]> {
    let inventory = this.inventories.get(type);
    if (!inventory) {
      inventory = this.fetchRemote(type);
      this.inventories.set(type, inventory);
    }
    return inventory;
  }

  recordPost(
    type: ResourceType,
    resourceId: string,
    payload: NameablePayload,
    section: Record<string, ResourceState>,
  ): void {
    const name = extractResourceName(payload) ?? resourceId;
    const stateMatches = Object.entries(section)
      .filter(
        ([key, entry]) =>
          extractBaseSlug(key) === slugify(name) &&
          !entry.uuid.startsWith("dry-run-"),
      )
      .map(([, entry]) => ({ id: entry.uuid, name }));
    this.posts.set(`${type}:${resourceId}`, {
      type,
      resourceId,
      name,
      stateMatches,
    });
  }

  async format(): Promise<string> {
    const lines: string[] = [];
    const unavailable = new Set<ResourceType>();
    for (const post of this.posts.values()) {
      const matches = new Map(
        post.stateMatches.map((entry) => [entry.id, entry]),
      );
      try {
        for (const remote of await this.getRemoteList(post.type)) {
          if (slugify(extractResourceName(remote) ?? "") === slugify(post.name))
            matches.set(remote.id, remote);
        }
      } catch (error) {
        unavailable.add(post.type);
        lines.push(
          `  Inventory unavailable for ${post.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      for (const remote of matches.values()) {
        lines.push(
          `  - ${post.type} "${extractResourceName(remote) ?? post.name}" (${remote.id}): ${post.resourceId} would create a new resource; --adopt ${post.resourceId} to take this over`,
        );
      }
    }
    if (!lines.length) return "Name collisions: none";
    return [
      "Name collisions:",
      ...lines,
      ...(unavailable.size
        ? [
            "  Collision check incomplete: review unavailable inventories before deploying.",
          ]
        : []),
    ].join("\n");
  }
}
