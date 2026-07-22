import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ResourceState } from "./types.ts";

const BEGIN = "# BEGIN VAPI MANAGED BINDINGS";
const END = "# END VAPI MANAGED BINDINGS";

export interface PhoneNumberBinding {
  id: string;
  name?: string;
}

interface BindingCandidate {
  key: string;
  uuid: string;
  label: string;
  confirmed: boolean;
}

export interface BindingEnvResult {
  content: string;
  count: number;
  warnings: string[];
}

export function updateEnvConnection(
  existingContent: string,
  token: string,
  baseUrl?: string,
): string {
  const preserved = existingContent
    .split("\n")
    .filter((line) => !/^\s*VAPI_(TOKEN|BASE_URL)\s*=/.test(line))
    .join("\n")
    .trim();
  const connection = [`VAPI_TOKEN=${token}`];
  if (baseUrl) connection.push(`VAPI_BASE_URL=${baseUrl}`);
  return `${connection.join("\n")}${preserved ? `\n\n${preserved}` : ""}\n`;
}

function parseAssignments(content: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) assignments.set(match[1]!, match[2]!.trim());
  }
  return assignments;
}

function splitManagedBlock(content: string): {
  manual: string;
  managed: string;
} {
  const start = content.indexOf(BEGIN);
  if (start === -1) return { manual: content, managed: "" };

  const end = content.indexOf(END, start);
  if (end === -1) {
    throw new Error(`Found "${BEGIN}" without a matching "${END}"`);
  }

  return {
    manual: `${content.slice(0, start)}${content.slice(end + END.length)}`,
    managed: content.slice(start, end + END.length),
  };
}

function envSuffix(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function updateBindingEnv(
  existingContent: string,
  credentials: Record<string, ResourceState>,
  phoneNumbers: PhoneNumberBinding[],
): BindingEnvResult {
  const { manual, managed } = splitManagedBlock(existingContent);
  const manualAssignments = parseAssignments(manual);
  const previousByUuid = new Map<string, string>();
  for (const [key, uuid] of parseAssignments(managed)) {
    if (
      key.startsWith("VAPI_CREDENTIAL_") ||
      key.startsWith("VAPI_PHONE_NUMBER_")
    ) {
      previousByUuid.set(uuid, key);
    }
  }

  const warnings: string[] = [];
  const candidates: BindingCandidate[] = Object.entries(credentials).map(
    ([alias, entry]) => {
      const previousKey = previousByUuid.get(entry.uuid);
      return {
        key: previousKey ?? `VAPI_CREDENTIAL_${envSuffix(alias)}`,
        uuid: entry.uuid,
        label: `credential "${alias}"`,
        confirmed: previousKey !== undefined,
      };
    },
  );

  for (const phone of phoneNumbers) {
    const previousKey = previousByUuid.get(phone.id);
    if (!previousKey && !phone.name?.trim()) {
      warnings.push(
        `Phone number ${phone.id} has no name, so no stable binding alias was generated.`,
      );
      continue;
    }
    candidates.push({
      key:
        previousKey ?? `VAPI_PHONE_NUMBER_${envSuffix(phone.name as string)}`,
      uuid: phone.id,
      label: `phone number "${phone.name ?? phone.id}"`,
      confirmed: previousKey !== undefined,
    });
  }

  const candidatesByKey = new Map<string, BindingCandidate[]>();
  for (const candidate of candidates) {
    const group = candidatesByKey.get(candidate.key) ?? [];
    group.push(candidate);
    candidatesByKey.set(candidate.key, group);
  }

  const generated = new Map<string, string>();
  for (const [key, group] of candidatesByKey) {
    const manualValue = manualAssignments.get(key);
    if (manualValue !== undefined) {
      if (!group.some((candidate) => candidate.uuid === manualValue)) {
        warnings.push(
          `${key} resolves to ${group.map((candidate) => candidate.uuid).join(" or ")}, but ${manualValue} is manually configured; keeping the manually managed value.`,
        );
      }
      continue;
    }

    const distinctIds = new Set(group.map((candidate) => candidate.uuid));
    if (distinctIds.size > 1) {
      const confirmed = group.filter((candidate) => candidate.confirmed);
      if (confirmed.length === 1) {
        generated.set(key, confirmed[0]!.uuid);
        warnings.push(
          `${key} is already confirmed for ${confirmed[0]!.label}; omitted ${group.length - 1} new same-name binding(s).`,
        );
        continue;
      }
      warnings.push(
        `Binding ${key} is ambiguous (${group.map((item) => item.label).join(", ")}); name the resources distinctly or bind them manually.`,
      );
      continue;
    }

    const candidate = group[0]!;
    generated.set(key, candidate.uuid);
  }

  const block = [
    BEGIN,
    ...[...generated.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, uuid]) => `${key}=${uuid}`),
    END,
  ].join("\n");
  const content = `${manual.trimEnd()}\n\n${block}\n`;
  return { content, count: generated.size, warnings };
}

export async function syncBindings(
  envPath: string,
  credentials: Record<string, ResourceState>,
  phoneNumbers: PhoneNumberBinding[],
): Promise<BindingEnvResult> {
  const existing = existsSync(envPath) ? await readFile(envPath, "utf-8") : "";
  const result = updateBindingEnv(existing, credentials, phoneNumbers);
  if (result.content !== existing) await writeFile(envPath, result.content);
  return result;
}

export async function fetchAllPhoneNumbers(
  getJson: (endpoint: string) => Promise<unknown>,
  limit = 1000,
): Promise<PhoneNumberBinding[]> {
  const phoneNumbers: PhoneNumberBinding[] = [];
  for (let page = 1; ; page++) {
    const data = await getJson(
      `/v2/phone-number?limit=${limit}&page=${page}`,
    );
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray((data as { results?: unknown }).results)
    ) {
      throw new Error(
        `Phone-number page ${page} is missing a results array; keeping existing bindings unchanged.`,
      );
    }
    const pageData = data as {
      results: PhoneNumberBinding[];
      metadata?: { totalItems?: number };
    };
    const results = pageData.results;
    phoneNumbers.push(...results);

    const totalItems = pageData.metadata?.totalItems;
    if (
      results.length === 0 ||
      (typeof totalItems === "number" && phoneNumbers.length >= totalItems) ||
      (totalItems === undefined && results.length < limit)
    ) {
      return phoneNumbers;
    }
  }
}
