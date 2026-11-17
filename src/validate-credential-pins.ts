// ─────────────────────────────────────────────────────────────────────────────
// Credential pins: does a `credentialIds` list hide a key the org has saved?
//
// On a call, `credentialIds` is not a choice for one provider. As soon as any
// assistant in the call lists any id, the listed ids are the only keys the
// whole call may use, and every squad member's list is pooled into one. A
// provider whose key is left off does not fail: it runs on Vapi's own key, a
// tool request goes out without its key, and recordings skip the org's bucket.
//
// This check fires only when the list leaves out a key the org HAS saved for
// something the call uses. An org with no key of its own for a provider is
// relying on Vapi's on purpose and is left alone. A phone number's own
// credential stays usable whatever the list says, so it is never reported.
//
// Config-free: the caller passes the state, the credential kinds and whether
// the org is customer-keys-only (a finding is then an error, else a warning).
// ─────────────────────────────────────────────────────────────────────────────

import {
  type CredentialKinds,
  credentialKindsLabel,
} from "./credential-kinds.ts";
import { credentialReverseMap } from "./credentials.ts";
import { referencesCollect } from "./resolver.ts";
import type { LoadedResources, ResourceType, StateFile } from "./types.ts";
import type { ValidationFinding } from "./validate.ts";

type Data = Record<string, unknown>;

// Key providers that can serve a model provider. A provider not listed here
// takes a key saved under its own name, as voices and transcribers do.
const MODEL_KEY_PROVIDERS: Record<string, string[]> = {
  openai: ["openai", "azure-openai"],
};

// Storage keys. Every call uploads its recording and other files with the
// first one it may use; gcp, azure and supabase keys only count as storage
// when a bucket is set on them.
const STORAGE_PROVIDERS = new Set(["s3", "cloudflare", "s3-compatible", "aws"]);
const STORAGE_PROVIDERS_WITH_BUCKET = new Set(["gcp", "azure", "supabase"]);

const record = (value: unknown): Data | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const refClean = (id: string) => id.split("##")[0]?.trim() ?? "";
const quoted = (names: Iterable<string>) =>
  [...names].map((name) => `"${name}"`).join(", ");

// Overrides laid over an assistant the way the platform lays them: mappings
// merge key by key, lists are joined (so the assistant's own credentialIds
// stay and the override's are added), and a block for a different provider
// replaces the assistant's block.
function overlay(current: unknown, override: unknown): unknown {
  if (override === undefined) return current;
  if (Array.isArray(override)) return [...list(current), ...override];
  const over = record(override);
  if (!over) return override;
  if (Object.keys(over).length === 0) return current ?? override;
  const base = record(current);
  if (!base) return override;
  if (
    typeof over.provider === "string" &&
    typeof base.provider === "string" &&
    over.provider !== base.provider
  )
    return override;
  const merged: Data = { ...base };
  for (const [key, value] of Object.entries(over))
    merged[key] = overlay(base[key], value);
  return merged;
}

// A member's overrides: the squad's membersOverrides replace the member's
// own assistantOverrides key by key, except tools:append, which is joined.
function memberOverrides(member: Data, squad: Data): Data {
  const own = record(member.assistantOverrides) ?? {};
  const shared = record(squad.membersOverrides) ?? {};
  const merged: Data = { ...own, ...shared };
  const appended = [
    ...list(own["tools:append"]),
    ...list(shared["tools:append"]),
  ];
  if (appended.length > 0) merged["tools:append"] = appended;
  return merged;
}

// Every `credentialId` value under a resource: a tool, a server, a model.
function credentialRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) credentialRefs(item, refs);
    return refs;
  }
  for (const [key, child] of Object.entries(record(value) ?? {})) {
    if (key === "credentialIds") continue;
    if (key !== "credentialId") credentialRefs(child, refs);
    else if (typeof child === "string" && child) refs.add(child);
  }
  return refs;
}

interface ProviderUse {
  what: string;
  provider: string;
  keyProviders: string[];
}

function providerUses(assistant: Data): ProviderUse[] {
  const uses: ProviderUse[] = [];
  const add = (
    what: string,
    block: unknown,
    keyProviders: Record<string, string[]> = {},
  ) => {
    const provider = record(block)?.provider;
    if (typeof provider === "string" && provider)
      uses.push({
        what,
        provider,
        keyProviders: keyProviders[provider] ?? [provider],
      });
  };
  const voice = record(assistant.voice);
  const transcriber = record(assistant.transcriber);
  add("model", assistant.model, MODEL_KEY_PROVIDERS);
  add("voice", voice);
  for (const fallback of list(record(voice?.fallbackPlan)?.voices))
    add("fallback voice", fallback);
  add("transcriber", transcriber);
  for (const fallback of list(record(transcriber?.fallbackPlan)?.transcribers))
    add("fallback transcriber", fallback);
  return uses;
}

// One assistant as it runs on a call, and who to name in a message.
interface Participant {
  label: string;
  assistant: Data;
}

interface CallTarget {
  type: ResourceType;
  resourceId: string;
  participants: Participant[];
}

export function validateCredentialPins(args: {
  loaded: LoadedResources;
  org: string;
  state: StateFile;
  // What each saved credential is a key for; undefined before the first pull
  // that recorded it.
  kinds: CredentialKinds | undefined;
  customerKeysOnly: boolean;
}): ValidationFinding[] {
  const { loaded, org, state, kinds, customerKeysOnly } = args;
  const severity = customerKeysOnly ? "error" : "warn";
  const uuidToName = credentialReverseMap(state);
  const nameOf = (ref: string) => uuidToName.get(ref) ?? ref;
  const toolUuidToId = new Map(
    Object.entries(state.tools).map(([id, entry]) => [entry.uuid, id]),
  );
  const tools = new Map(loaded.tools.map((tool) => [tool.resourceId, tool]));
  const assistants = new Map(
    loaded.assistants.map((assistant) => [assistant.resourceId, assistant]),
  );

  const targets: CallTarget[] = [];
  for (const assistant of loaded.assistants)
    targets.push({
      type: "assistants",
      resourceId: assistant.resourceId,
      participants: [{ label: "this assistant", assistant: assistant.data }],
    });
  for (const squad of loaded.squads) {
    const participants: Participant[] = [];
    for (const item of list(squad.data.members)) {
      const member = record(item);
      if (!member) continue;
      const id =
        typeof member.assistantId === "string"
          ? refClean(member.assistantId)
          : undefined;
      // A member that isn't a file here (a dashboard-owned assistant) can't
      // be read, so it adds nothing to the check.
      const base = record(member.assistant) ?? (id && assistants.get(id)?.data);
      if (!base) continue;
      const name = id ?? (typeof base.name === "string" ? base.name : "inline");
      participants.push({
        label: `member "${name}"`,
        assistant: overlay(base, memberOverrides(member, squad.data)) as Data,
      });
    }
    targets.push({
      type: "squads",
      resourceId: squad.resourceId,
      participants,
    });
  }

  const findings: ValidationFinding[] = [];
  const missingKinds = Object.keys(state.credentials).filter(
    (name) => !kinds?.[name],
  );
  let kindsReported = false;

  for (const target of targets) {
    const pin = new Set(
      target.participants
        .flatMap((participant) => list(participant.assistant.credentialIds))
        .filter((id): id is string => typeof id === "string" && id !== "")
        .map(nameOf),
    );
    if (pin.size === 0) continue;
    const pinText = quoted(pin);
    const finding = (rule: string, message: string) =>
      findings.push({
        severity,
        type: target.type,
        resourceId: target.resourceId,
        rule,
        message,
        fieldPath: "credentialIds",
      });
    const onlyListed =
      "A call that has a credentialIds list can use only the keys on it";

    // Keys named outright: a tool's or a server's credentialId.
    const named = new Map<string, Set<string>>();
    const name = (ref: string, who: string) => {
      const key = nameOf(ref);
      if (!pin.has(key)) named.set(key, (named.get(key) ?? new Set()).add(who));
    };
    for (const { label, assistant } of target.participants) {
      for (const ref of credentialRefs(assistant)) name(ref, label);
      for (const ref of referencesCollect(assistant).get("tools") ?? []) {
        const id = toolUuidToId.get(refClean(ref)) ?? refClean(ref);
        for (const toolRef of credentialRefs(tools.get(id)?.data))
          name(toolRef, `tool "${id}"`);
      }
    }
    for (const [key, who] of named)
      finding(
        "credential-pin-hides-key",
        `${[...who].join(" and ")} ${who.size > 1 ? "name" : "names"} ` +
          `credential "${key}", but the call's ` +
          `credentialIds list (${pinText}) leaves it out. ${onlyListed}, so ` +
          `that request would go out without the key. Add "${key}" to the list`,
      );

    // The rest needs each key's provider. Without it, say so once and stop.
    const unknown = [...pin].filter((key) => !kinds?.[key]);
    if (!kinds || missingKinds.length > 0 || unknown.length > 0) {
      if (unknown.length > 0 && kinds && missingKinds.length === 0)
        finding(
          "credential-pin-unchecked",
          `credentialIds lists ${quoted(unknown)}, which this repo has no ` +
            `record of, so the list can't be checked against the keys this ` +
            `org has saved. Check the name, or run \`npm run pull -- ${org} ` +
            `--bootstrap\` if the key was just created`,
        );
      else if (!kindsReported)
        finding(
          "credential-pin-unchecked",
          `${credentialKindsLabel(org)} ` +
            (kinds
              ? `has no entry for ${quoted(missingKinds)}`
              : "doesn't exist yet") +
            `, so credentialIds lists in this org can't be checked against ` +
            `the keys it has saved. Run \`npm run pull -- ${org} --bootstrap\` ` +
            `and commit that file`,
        );
      kindsReported = true;
      continue;
    }

    const pinnedProviders = new Set(
      [...pin].map((key) => kinds[key]!.provider),
    );
    for (const { assistant } of target.participants)
      for (const inline of list(assistant.credentials)) {
        const provider = record(inline)?.provider;
        if (typeof provider === "string") pinnedProviders.add(provider);
      }
    const savedFor = (providers: string[]) =>
      Object.keys(kinds).filter((key) =>
        providers.includes(kinds[key]!.provider),
      );

    // Model, voice and transcriber, with their fallbacks.
    const hidden = new Map<
      string,
      { provider: string; keys: string[]; uses: Set<string> }
    >();
    for (const { label, assistant } of target.participants)
      for (const use of providerUses(assistant)) {
        if (use.keyProviders.some((provider) => pinnedProviders.has(provider)))
          continue;
        const keys = savedFor(use.keyProviders);
        if (keys.length === 0) continue;
        const entry = hidden.get(use.provider) ?? {
          provider: use.provider,
          keys,
          uses: new Set<string>(),
        };
        entry.uses.add(`the ${use.what} of ${label}`);
        hidden.set(use.provider, entry);
      }
    for (const { provider, keys, uses } of hidden.values())
      finding(
        "credential-pin-hides-key",
        `${[...uses].join(" and ")} ${uses.size > 1 ? "use" : "uses"} ` +
          `${provider}, and this org has ` +
          `${quoted(keys)} saved for it, but the call's credentialIds list ` +
          `(${pinText}) has no key for ${provider}. ${onlyListed}, so ` +
          `${provider} would run on Vapi's own key, not yours. Add the key ` +
          `to the list`,
      );

    // Keys every call uses when the org has them.
    const storage = Object.keys(kinds).filter((key) => {
      const kind = kinds[key]!;
      return (
        STORAGE_PROVIDERS.has(kind.provider) ||
        (STORAGE_PROVIDERS_WITH_BUCKET.has(kind.provider) && kind.bucket)
      );
    });
    if (storage.length > 0 && !storage.some((key) => pin.has(key)))
      finding(
        "credential-pin-hides-key",
        `this org has a storage bucket key saved (${quoted(storage)}), but ` +
          `the call's credentialIds list (${pinText}) has none. ` +
          `${onlyListed}, so its recording and other call files would not ` +
          `go to your bucket. Add the key to the list`,
      );
    const langfuse = savedFor(["langfuse"]);
    if (langfuse.length > 0 && !pinnedProviders.has("langfuse"))
      finding(
        "credential-pin-hides-key",
        `this org has a Langfuse key saved (${quoted(langfuse)}), but the ` +
          `call's credentialIds list (${pinText}) leaves it out. ` +
          `${onlyListed}, so the call would not be traced. Add the key to ` +
          `the list`,
      );
  }
  return findings;
}
