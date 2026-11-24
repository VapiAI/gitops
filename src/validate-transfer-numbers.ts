import type { LoadedResources } from "./types.ts";
import type { ValidationFinding } from "./validate.ts";

export function validateTransferNumbers(
  resources: LoadedResources,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const type of ["tools", "assistants", "squads"] as const) {
    for (const resource of resources[type]) {
      const visit = (value: unknown, path: string): void => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) {
          value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        const object = value as Record<string, unknown>;
        if (
          object.type === "transferCall" &&
          Array.isArray(object.destinations)
        ) {
          object.destinations.forEach((destination, index) => {
            const number = destination?.number;
            if (typeof number !== "string" || !/{{|{%/.test(number)) return;
            // Vapi: libs/core/src/types/tool.types/transferCallTool.types.ts (TransferDestinationNumber).
            findings.push({
              severity: "error",
              type,
              resourceId: resource.resourceId,
              rule: "transfer-number-liquid",
              fieldPath: `${path ? `${path}.` : ""}destinations[${index}].number`,
              message:
                "The API rejects Liquid in transfer numbers: E.164 validation applies, and numberE164CheckEnabled:false still requires ^\\+?[a-zA-Z0-9]+$. Use a per-practice literal number, e.g. an inline tool in the squad's membersOverrides['tools:append']; see examples/nhs-shared-squads.",
            });
          });
        }
        for (const [key, child] of Object.entries(object)) {
          visit(child, path ? `${path}.${key}` : key);
        }
      };
      visit(resource.data, "");
    }
  }
  return findings;
}
