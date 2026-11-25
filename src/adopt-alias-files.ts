import { confirm } from "@inquirer/prompts";
import { rm } from "fs/promises";
import { relative } from "path";
import type { AdoptionAlias } from "./adopt.ts";
import { withoutLatestVersion } from "./canonical.ts";
import { BASE_DIR, DRY_RUN, RESOURCES_DIR, VAPI_ENV } from "./config.ts";
import { deleteBaseline, readBaseline } from "./hash-store.ts";
import { parseResourceDataFromFile } from "./resource-parse.ts";
import { hashPayload } from "./state-serialize.ts";
import type { LoadedResources } from "./types.ts";

export async function prepareAliasCleanup(
  aliases: AdoptionAlias[],
  resources: LoadedResources,
) {
  const files = aliases.flatMap((alias) =>
    resources[alias.type]
      .filter((file) => file.resourceId === alias.resourceId)
      .map((file) => ({ ...alias, file })),
  );
  const problems: {
    file: string;
    type: AdoptionAlias["type"];
    message: string;
  }[] = [];
  for (const { file, uuid, adoptedAs, type } of files) {
    const path = relative(BASE_DIR, file.filePath);
    const baseline = readBaseline(VAPI_ENV, uuid);
    let matches = false;
    if (baseline) {
      try {
        const raw = parseResourceDataFromFile(file.filePath, RESOURCES_DIR);
        const config = withoutLatestVersion(raw, type);
        matches =
          hashPayload(config) === baseline ||
          (config !== raw && hashPayload(raw) === baseline);
      } catch {}
    }
    if (!matches) {
      const message = `${path}: local edits or no baseline. Delete it by hand (or merge its edits into ${adoptedAs}) and rerun.`;
      if (
        DRY_RUN ||
        process.argv.includes("--json") ||
        !process.stdin.isTTY ||
        !(await confirm({
          message: `Delete ${path}? Local edits may be lost.`,
          default: false,
        }))
      ) {
        problems.push({ file: path, type, message });
      }
    }
  }
  return {
    problems,
    async run() {
      for (const { file, adoptedAs, type } of files) {
        const path = relative(BASE_DIR, file.filePath);
        if (DRY_RUN) console.log(`would delete ${path}`);
        else {
          await rm(file.filePath);
          console.log(
            `Deleted ${path}: same remote resource, now adopted as ${adoptedAs}`,
          );
        }
        resources[type].splice(resources[type].indexOf(file), 1);
      }
      if (!DRY_RUN)
        for (const { uuid } of aliases) await deleteBaseline(VAPI_ENV, uuid);
    },
  };
}
