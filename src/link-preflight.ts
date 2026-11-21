import { relative } from "path";
import { type AdoptionAlias, adoptResources } from "./adopt.ts";
import { prepareAliasCleanup } from "./adopt-alias-files.ts";
import {
  ADOPT_TARGETS,
  ALLOW_NEW_FILES,
  APPLY_FILTER,
  BASE_DIR,
  BOOTSTRAP_SYNC,
  DRY_RUN,
  VAPI_ENV,
} from "./config.ts";
import { extractResourceName, type RemoteResource } from "./dep-dedup.ts";
import { detectOrphanYamls } from "./new-file-gate.ts";
import { extractBaseSlug, slugify } from "./slug-utils.ts";
import type { TouchedSets } from "./state-merge.ts";
import { type StopIssue, shellQuote } from "./stop-report.ts";
import type { LoadedResources, ResourceType, StateFile } from "./types.ts";
import { VALID_RESOURCE_TYPES } from "./types.ts";

export async function prepareResourceLinks(opts: {
  resources: LoadedResources;
  state: StateFile;
  touched: TouchedSets;
  getRemoteList: (type: ResourceType) => Promise<RemoteResource[]>;
}) {
  const issues: StopIssue[] = [];
  const errors: { target: string; message: string }[] = [];
  let aliases: AdoptionAlias[] = [];
  const preview = await adoptResources({
    ...opts,
    targets: ADOPT_TARGETS,
    dryRun: true,
    quiet: true,
    errors,
    cleanupAliases: async (entries) => {
      aliases = entries;
    },
  });
  const base = `npm run push -- ${shellQuote(VAPI_ENV)}`;
  for (const type of VALID_RESOURCE_TYPES) {
    for (const file of opts.resources[type]) {
      if (preview[type][file.resourceId]) continue;
      const owners = Object.entries(preview[type]).filter(
        ([id, entry]) =>
          entry.origin === "adopted" &&
          file.resourceId.endsWith(`-${entry.uuid.slice(0, 8)}`) &&
          extractBaseSlug(file.resourceId) === extractBaseSlug(id) &&
          opts.resources[type].some((resource) => resource.resourceId === id),
      );
      if (
        owners.length === 1 &&
        !aliases.some(
          (alias) =>
            alias.type === type && alias.resourceId === file.resourceId,
        )
      ) {
        const [adoptedAs, { uuid }] = owners[0]!;
        aliases.push({ type, resourceId: file.resourceId, uuid, adoptedAs });
      }
    }
  }
  for (const { target, message } of errors) {
    const id = target.split("=")[0]!;
    const type = VALID_RESOURCE_TYPES.find((type) =>
      opts.resources[type].some((file) => file.resourceId === id),
    );
    const file = type
      ? opts.resources[type].find((file) => file.resourceId === id)
      : undefined;
    const path = file ? relative(BASE_DIR, file.filePath) : id;
    const alreadyLinked = message.includes("already linked");
    const noCandidates = message.includes("no candidates");
    const missing = message.includes("no such file");
    issues.push({
      file: path,
      resourceType: type ?? "unknown",
      problem: message,
      fix: missing
        ? "Remove this --adopt argument, or restore the intended local file and rerun."
        : noCandidates
          ? "If genuinely new, remove this --adopt argument and approve --allow-new-files. If renamed/stale, delete the file."
          : alreadyLinked
            ? "Already linked: remove this --adopt argument and retry."
            : "Check the file and candidate UUIDs; choose a resource explicitly or remove this adoption request.",
      command: missing
        ? base
        : noCandidates
          ? `${base} --allow-new-files ${shellQuote(path)} OR rm -- ${shellQuote(path)}`
          : alreadyLinked
            ? `${base} ${shellQuote(path)}`
            : `${base} --adopt ${shellQuote(id)}=<uuid> ${shellQuote(path)}`,
      needsChoice: !alreadyLinked,
      ...(alreadyLinked ? { args: [shellQuote(path)] } : {}),
    });
  }
  const suggestedOwners = new Map<string, StopIssue[]>();
  const cleanup = await prepareAliasCleanup(aliases, opts.resources);
  for (const issue of cleanup.problems)
    issues.push({
      file: issue.file,
      resourceType: issue.type,
      problem: issue.message,
      fix: "Merge its edits into the adopted file, or delete this file by hand, then rerun.",
      command: `rm -- ${shellQuote(issue.file)}`,
      needsChoice: true,
    });
  const removed = new Set(
    aliases.map((alias) => `${alias.type}:${alias.resourceId}`),
  );
  if (!BOOTSTRAP_SYNC && !ALLOW_NEW_FILES) {
    const report = detectOrphanYamls({
      state: preview,
      filePathFilter: APPLY_FILTER.filePaths,
    });
    for (const entry of report.orphans) {
      if (removed.has(`${entry.type}:${entry.resourceId}`)) continue;
      const file = opts.resources[entry.type].find(
        (file) => file.resourceId === entry.resourceId,
      );
      if (
        !file ||
        errors.some((error) => error.target.split("=")[0] === entry.resourceId)
      )
        continue;
      const path = relative(BASE_DIR, file.filePath);
      const name = slugify(extractResourceName(file.data) ?? entry.resourceId);
      const matches = new Set(
        Object.entries(opts.state[entry.type])
          .filter(([key]) => extractBaseSlug(key) === name)
          .map(([, value]) => value.uuid),
      );
      let lookupError: string | undefined;
      try {
        for (const remote of await opts.getRemoteList(entry.type))
          if (slugify(extractResourceName(remote) ?? "") === name)
            matches.add(remote.id);
      } catch (error) {
        lookupError = error instanceof Error ? error.message : String(error);
      }
      const adopt = matches.size === 1 && !lookupError;
      const args = [
        `--adopt ${shellQuote(entry.resourceId)}`,
        shellQuote(path),
      ];
      const commands = [...matches]
        .sort()
        .map(
          (uuid) =>
            `${base} --adopt ${shellQuote(entry.resourceId + (matches.size > 1 ? "=" + uuid : ""))} ${shellQuote(path)}`,
        );
      const issue: StopIssue = {
        file: path,
        resourceType: entry.type,
        problem: `Not linked to any resource in ${VAPI_ENV} yet.${matches.size ? ` Same-named resource(s): ${[...matches].join(", ")}; NOT linked automatically.` : ""}${lookupError ? ` Inventory unavailable: ${lookupError}` : ""}`,
        fix: matches.size
          ? "To take over a same-named resource, explicitly approve adoption. If genuinely new, approve --allow-new-files instead. If renamed/stale, delete the file."
          : "If new, approve --allow-new-files. If renamed/stale, delete the file (merge any needed edits first).",
        command: [
          ...commands,
          `${base} --allow-new-files ${shellQuote(path)}`,
          `rm -- ${shellQuote(path)}`,
        ].join(" OR "),
        needsChoice: !adopt,
        ...(adopt ? { args } : {}),
      };
      issues.push(issue);
      if (adopt) {
        const uuid = [...matches][0]!;
        const key = `${entry.type}:${uuid}`;
        suggestedOwners.set(key, [...(suggestedOwners.get(key) ?? []), issue]);
      }
    }
  }
  for (const shared of suggestedOwners.values()) {
    if (shared.length < 2) continue;
    for (const issue of shared) {
      issue.needsChoice = true;
      issue.problem +=
        " Another file has the same proposed remote UUID; choose which file should own it.";
    }
  }
  const approvedTargets = ADOPT_TARGETS.filter(
    (target) => !errors.some((error) => error.target === target),
  ).flatMap((target) => [
    `--adopt ${shellQuote(target)}`,
    ...VALID_RESOURCE_TYPES.flatMap((type) =>
      opts.resources[type]
        .filter((file) => file.resourceId === target.split("=")[0])
        .map((file) => shellQuote(relative(BASE_DIR, file.filePath))),
    ),
  ]);
  for (const issue of issues) {
    if (issue.args)
      issue.args = [
        ...approvedTargets,
        ...(ALLOW_NEW_FILES ? ["--allow-new-files"] : []),
        ...issue.args,
      ];
  }
  const grouped = new Map<string, StopIssue>();
  for (const issue of issues) {
    const key = `${issue.resourceType}:${issue.file}`;
    const existing = grouped.get(key);
    if (!existing) grouped.set(key, issue);
    else {
      if (!existing.problem.includes(issue.problem))
        existing.problem += ` ${issue.problem}`;
      if (!existing.command.includes(issue.command))
        existing.command += ` OR ${issue.command}`;
      existing.needsChoice ||= issue.needsChoice;
    }
  }
  return {
    issues: [...grouped.values()],
    preview,
    async commit() {
      await cleanup.run();
      for (const type of VALID_RESOURCE_TYPES) {
        for (const id of new Set([
          ...Object.keys(opts.state[type]),
          ...Object.keys(preview[type]),
        ])) {
          if (
            JSON.stringify(opts.state[type][id]) !==
              JSON.stringify(preview[type][id]) &&
            !DRY_RUN
          )
            opts.touched[type].add(id);
        }
      }
      for (const target of ADOPT_TARGETS) {
        const id = target.split("=")[0]!;
        const type = VALID_RESOURCE_TYPES.find(
          (type) => preview[type][id]?.origin === "adopted",
        );
        if (type)
          console.log(
            `  ${DRY_RUN ? "would adopt" : "Adopting"} ${id} → ${preview[type][id]!.uuid}`,
          );
      }
    },
  };
}
