// Build every target payload of one check from the files under rootDir.
// Shared by the dry run and the live run, so both test the same body.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckDefinition, CheckTarget } from "./check-config.ts";
import type { CheckPayloadResult } from "./check-payload.ts";
import { checkPayloadBuild } from "./check-payload.ts";
import { promotionBindingsResolve, promotionStateParse } from "./promotion.ts";
import { orgResourcesRead } from "./resource-parse.ts";
import type { StateFile } from "./types.ts";

export interface CheckJob {
  check: CheckDefinition;
  target: CheckTarget;
  // `<check> / <type>/<id>`
  label: string;
  result: CheckPayloadResult;
}

export function checkTargetLabel(target: CheckTarget): string {
  return `${target.type}/${target.id}`;
}

function stateRead(root: string, org: string, warnings: string[]): StateFile {
  const path = join(root, `.vapi-state.${org}.json`);
  if (!existsSync(path)) {
    warnings.push(
      `no .vapi-state.${org}.json: references by UUID and credential bindings can't resolve`,
    );
    return promotionStateParse("{}");
  }
  return promotionStateParse(readFileSync(path, "utf8"));
}

export async function checkJobsBuild(
  root: string,
  check: CheckDefinition,
): Promise<CheckJob[]> {
  const job = (target: CheckTarget, result: CheckPayloadResult): CheckJob => ({
    check,
    target,
    label: `${check.name} / ${checkTargetLabel(target)}`,
    result,
  });
  if (!existsSync(join(root, "resources", check.org))) {
    return check.targets.map((target) =>
      job(target, {
        errors: [`resources/${check.org}/ does not exist`],
        warnings: [],
        bytes: 0,
      }),
    );
  }
  const warnings: string[] = [];
  const resources = await orgResourcesRead(root, check.org);
  const sourceState = stateRead(root, check.org, warnings);
  const runState =
    check.runOrg === check.org
      ? sourceState
      : stateRead(root, check.runOrg, warnings);
  const bindingsResolved = await promotionBindingsResolve(
    root,
    check.org,
    check.runOrg,
    sourceState,
  );
  return check.targets.map((target) => {
    const result = checkPayloadBuild({
      check,
      target,
      resources,
      sourceState,
      runState,
      bindingsResolved,
    });
    result.warnings.unshift(...warnings);
    return job(target, result);
  });
}
