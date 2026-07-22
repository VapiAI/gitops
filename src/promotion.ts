import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ResourceType, StateFile } from "./types.ts";

type BindingPolicy = "bind" | "omit";

export interface PromotionBindingMap {
  default: BindingPolicy;
  aliases: Record<string, BindingPolicy>;
}

export interface PromotionBindings {
  credentials: PromotionBindingMap;
  phoneNumbers: PromotionBindingMap;
}

export interface PromotionOrg {
  baseUrl?: string;
  bindings: PromotionBindings;
}

export interface PromotionPipeline {
  orgs: string[];
  resources: string[];
}

export interface PromotionConfig {
  version: 1;
  orgs: Record<string, PromotionOrg>;
  pipelines: Record<string, PromotionPipeline>;
}

export interface PromotionChange {
  kind: "create" | "update" | "delete";
  path: string;
  content?: string;
}

export interface PromotionPlan {
  rootDir: string;
  target: string;
  changes: PromotionChange[];
}

export interface PromotionPlanOptions {
  rootDir: string;
  source: string;
  target: string;
  patterns: string[];
  sourceState: StateFile;
  targetState: StateFile;
  bindings?: PromotionBindings;
  allowEmptySourceDeletion?: boolean;
}

interface PromotionResource {
  path: string;
  content: string;
  type: ResourceType;
  id: string;
}

interface PromotionBindingsResolved {
  credentialReverse: Map<string, string>;
  sourcePhones: Map<string, string>;
  targetPhones: Map<string, string>;
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const FOLDER_MAP: Record<ResourceType, string> = {
  tools: "tools",
  structuredOutputs: "structuredOutputs",
  assistants: "assistants",
  squads: "squads",
  personalities: "simulations/personalities",
  scenarios: "simulations/scenarios",
  simulations: "simulations/tests",
  simulationSuites: "simulations/suites",
  evals: "evals",
};
const VALID_EXTENSIONS: readonly string[] = [".yml", ".yaml", ".ts", ".md"];
const REFERENCE_FIELDS: Record<string, ResourceType> = {
  toolId: "tools",
  toolIds: "tools",
  structuredOutputId: "structuredOutputs",
  structuredOutputIds: "structuredOutputs",
  assistantId: "assistants",
  assistantIds: "assistants",
  assistant_ids: "assistants",
  personalityId: "personalities",
  scenarioId: "scenarios",
  simulationId: "simulations",
  simulationIds: "simulations",
};
const DEFAULT_BINDINGS: PromotionBindings = {
  credentials: { default: "bind", aliases: {} },
  phoneNumbers: { default: "omit", aliases: {} },
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return Object.fromEntries(Object.entries(value));
}

function policy(value: unknown, label: string): BindingPolicy {
  if (value === "bind" || value === "omit") return value;
  throw new Error(`${label} must be "bind" or "omit"`);
}

function bindingMap(
  value: unknown,
  fallback: BindingPolicy,
  label: string,
): PromotionBindingMap {
  if (value === undefined) return { default: fallback, aliases: {} };
  const raw = object(value, label);
  const aliasesRaw =
    raw.aliases === undefined ? {} : object(raw.aliases, `${label}.aliases`);
  const aliases: Record<string, BindingPolicy> = {};
  for (const [alias, configured] of Object.entries(aliasesRaw))
    aliases[alias] = policy(configured, `${label}.aliases.${alias}`);
  for (const [alias, configured] of Object.entries(raw)) {
    if (alias !== "default" && alias !== "aliases")
      aliases[alias] = policy(configured, `${label}.${alias}`);
  }
  return {
    default:
      raw.default === undefined
        ? fallback
        : policy(raw.default, `${label}.default`),
    aliases,
  };
}

function bindings(value: unknown): PromotionBindings {
  const raw = value === undefined ? {} : object(value, "bindings");
  return {
    credentials: bindingMap(raw.credentials, "bind", "bindings.credentials"),
    phoneNumbers: bindingMap(raw.phoneNumbers, "omit", "bindings.phoneNumbers"),
  };
}

export function promotionConfigParse(content: string): PromotionConfig {
  const raw = object(parseYaml(content), "promotion.yml");
  if (raw.version !== 1) throw new Error("promotion.yml version must be 1");
  const orgsRaw = object(raw.orgs, "promotion.yml orgs");
  const orgs: Record<string, PromotionOrg> = {};
  for (const [slug, value] of Object.entries(orgsRaw)) {
    if (!SLUG_RE.test(slug)) throw new Error(`Invalid org slug: ${slug}`);
    const org = object(value ?? {}, `org ${slug}`);
    if (org.baseUrl !== undefined && typeof org.baseUrl !== "string")
      throw new Error(`org ${slug}.baseUrl must be a string`);
    orgs[slug] = {
      baseUrl: typeof org.baseUrl === "string" ? org.baseUrl : undefined,
      bindings: bindings(org.bindings),
    };
  }
  const pipelinesRaw = object(raw.pipelines, "promotion.yml pipelines");
  if (Object.keys(pipelinesRaw).length === 0)
    throw new Error("promotion.yml must declare at least one pipeline");
  const pipelines: Record<string, PromotionPipeline> = {};
  for (const [name, value] of Object.entries(pipelinesRaw)) {
    if (!SLUG_RE.test(name)) throw new Error(`Invalid pipeline slug: ${name}`);
    const pipeline = object(value, `pipeline ${name}`);
    if (
      !Array.isArray(pipeline.orgs) ||
      !pipeline.orgs.every((org) => typeof org === "string")
    )
      throw new Error(`pipeline ${name}.orgs must be a list of org slugs`);
    if (
      !Array.isArray(pipeline.resources) ||
      pipeline.resources.length === 0 ||
      !pipeline.resources.every(
        (pattern) => typeof pattern === "string" && pattern.length > 0,
      )
    )
      throw new Error(`pipeline ${name}.resources must be a non-empty list`);
    const orderedOrgs = pipeline.orgs;
    if (
      orderedOrgs.length < 2 ||
      new Set(orderedOrgs).size !== orderedOrgs.length
    )
      throw new Error(`pipeline ${name} must have at least two unique orgs`);
    for (const org of orderedOrgs)
      if (!orgs[org])
        throw new Error(`pipeline ${name} references undeclared org: ${org}`);
    pipelines[name] = {
      orgs: [...orderedOrgs],
      resources: [...pipeline.resources],
    };
  }
  return { version: 1, orgs, pipelines };
}

export function promotionTransitionValidate(
  config: PromotionConfig,
  pipelineName: string,
  source: string,
  target: string,
): PromotionPipeline {
  const pipeline = config.pipelines[pipelineName];
  if (!pipeline) throw new Error(`Unknown promotion pipeline: ${pipelineName}`);
  const sourceIndex = pipeline.orgs.indexOf(source);
  const targetIndex = pipeline.orgs.indexOf(target);
  if (sourceIndex === -1 || targetIndex === -1)
    throw new Error(
      `Both source and target must belong to pipeline ${pipelineName}`,
    );
  if (sourceIndex >= targetIndex)
    throw new Error(
      `Promotion transitions must move forward in pipeline ${pipelineName}`,
    );
  return pipeline;
}

function glob(pattern: string, path: string): boolean {
  let expression = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index++;
      continue;
    }
    if (char === "*") {
      expression += "[^/]*";
      continue;
    }
    if (char === "?") {
      expression += "[^/]";
      continue;
    }
    expression += "\\^$.|+(){}[]".includes(char ?? "") ? `\\${char}` : char;
  }
  return new RegExp(`^${expression}$`).test(path);
}

function selected(path: string, patterns: string[]): boolean {
  const stem = path.replace(/\.(yml|yaml|md|ts)$/, "");
  return patterns.some((pattern) => glob(pattern, path) || glob(pattern, stem));
}

async function ignorePatternsRead(
  root: string,
  org: string,
): Promise<string[]> {
  const path = join(root, "resources", org, ".vapi-ignore");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!"),
    );
}

function ignored(path: string, patterns: string[]): boolean {
  const stem = path.replace(/\.(yml|yaml|md|ts)$/, "");
  return patterns.some((pattern) => glob(pattern, stem));
}

function resourceType(path: string): { type: ResourceType; id: string } | null {
  for (const [type, folder] of Object.entries(FOLDER_MAP)) {
    if (!path.startsWith(`${folder}/`)) continue;
    const id = path.slice(folder.length + 1).replace(/\.(yml|yaml|md|ts)$/, "");
    return { type: type as ResourceType, id };
  }
  return null;
}

async function resourcesRead(
  root: string,
  org: string,
): Promise<PromotionResource[]> {
  const base = join(root, "resources", org);
  if (!existsSync(base)) return [];
  const files: PromotionResource[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory)).sort()) {
      if (entry.startsWith(".")) continue;
      const path = join(directory, entry);
      if ((await stat(path)).isDirectory()) {
        await visit(path);
        continue;
      }
      if (!VALID_EXTENSIONS.includes(extname(path))) continue;
      const relativePath = relative(base, path);
      const metadata = resourceType(relativePath);
      if (metadata)
        files.push({
          path: relativePath,
          content: await readFile(path, "utf8"),
          ...metadata,
        });
    }
  }
  await visit(base);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function referencesCanonicalize(
  value: unknown,
  sourceState: StateFile,
): unknown {
  const reverse: Record<ResourceType, Map<string, string>> = {} as Record<
    ResourceType,
    Map<string, string>
  >;
  for (const type of Object.keys(FOLDER_MAP) as ResourceType[])
    reverse[type] = new Map(
      Object.entries(sourceState[type]).map(([id, entry]) => [entry.uuid, id]),
    );
  function visit(current: unknown, key?: string): unknown {
    if (typeof current === "string" && key && REFERENCE_FIELDS[key]) {
      const clean = current.split("##")[0]?.trim() ?? "";
      return reverse[REFERENCE_FIELDS[key]].get(clean) ?? clean;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, key));
    if (!current || typeof current !== "object") return current;
    return Object.fromEntries(
      Object.entries(current).map(([childKey, child]) => [
        childKey,
        visit(child, childKey),
      ]),
    );
  }
  return visit(value);
}

function envBindings(content: string, prefix: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split("\n")) {
    const match = line.match(new RegExp(`^${prefix}([A-Z0-9_]+)=(.+)$`));
    if (match)
      result.set(match[1]!.toLowerCase().replace(/_/g, "-"), match[2]!.trim());
  }
  return result;
}

async function bindingsResolve(
  root: string,
  source: string,
  target: string,
  sourceState: StateFile,
): Promise<PromotionBindingsResolved> {
  const sourceEnv = existsSync(join(root, `.env.${source}`))
    ? await readFile(join(root, `.env.${source}`), "utf8")
    : "";
  const targetEnv = existsSync(join(root, `.env.${target}`))
    ? await readFile(join(root, `.env.${target}`), "utf8")
    : "";
  const credentialReverse = new Map(
    Object.entries(sourceState.credentials).map(([alias, entry]) => [
      entry.uuid,
      alias,
    ]),
  );
  const sourcePhones = new Map<string, string>();
  for (const [alias, id] of envBindings(sourceEnv, "VAPI_PHONE_NUMBER_"))
    sourcePhones.set(id, alias);
  return {
    credentialReverse,
    sourcePhones,
    targetPhones: envBindings(targetEnv, "VAPI_PHONE_NUMBER_"),
  };
}

function policyFor(map: PromotionBindingMap, alias: string): BindingPolicy {
  return map.aliases[alias] ?? map.aliases[alias.toUpperCase()] ?? map.default;
}

function bindingsApply(
  value: unknown,
  bindings: PromotionBindings,
  resolved: PromotionBindingsResolved,
  targetState: StateFile,
): unknown {
  function credential(ref: string): string | undefined {
    const alias = resolved.credentialReverse.get(ref) ?? ref;
    if (policyFor(bindings.credentials, alias) === "omit") return undefined;
    if (!targetState.credentials[alias])
      throw new Error(
        `Credential binding "${alias}" is required in the target state`,
      );
    return alias;
  }
  function phone(ref: string): string | undefined {
    const alias = (
      resolved.sourcePhones.get(ref) ?? ref.replace(/^VAPI_PHONE_NUMBER_/, "")
    )
      .toLowerCase()
      .replace(/_/g, "-");
    if (policyFor(bindings.phoneNumbers, alias) === "omit") return undefined;
    const target = resolved.targetPhones.get(alias);
    if (!target)
      throw new Error(
        `Phone-number binding "${alias}" is required in .env target bindings`,
      );
    return target;
  }
  function visit(current: unknown): unknown {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      if (key === "credentialId" && typeof child === "string") {
        const bound = credential(child);
        if (bound) output[key] = bound;
        continue;
      }
      if (key === "phoneNumberId" && typeof child === "string") {
        const bound = phone(child);
        if (bound) output[key] = bound;
        continue;
      }
      if (key === "credentialIds" && Array.isArray(child)) {
        output[key] = child
          .filter((item): item is string => typeof item === "string")
          .map(credential)
          .filter((item): item is string => item !== undefined);
        continue;
      }
      if (key === "phoneNumberIds" && Array.isArray(child)) {
        output[key] = child
          .filter((item): item is string => typeof item === "string")
          .map(phone)
          .filter((item): item is string => item !== undefined);
        continue;
      }
      output[key] = visit(child);
    }
    return output;
  }
  return visit(value);
}

function parseContent(
  content: string,
  path: string,
): { data: unknown; body?: string } {
  if (extname(path) !== ".md") return { data: parseYaml(content) };
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`Invalid Markdown frontmatter: ${path}`);
  return { data: parseYaml(match[1] ?? ""), body: match[2] ?? "" };
}

async function resourceData(
  file: PromotionResource,
  root: string,
  source: string,
): Promise<{ data: unknown; body?: string }> {
  if (extname(file.path) !== ".ts")
    return parseContent(file.content, file.path);
  const url = pathToFileURL(join(root, "resources", source, file.path)).href;
  const module = (await import(`${url}?promotion`)) as { default?: unknown };
  if (module.default === undefined)
    throw new Error(`TypeScript resource has no default export: ${file.path}`);
  return { data: module.default };
}

function renderContent(data: unknown, path: string, body?: string): string {
  const yaml = stringifyYaml(data);
  return extname(path) === ".md" ? `---\n${yaml}---\n${body ?? ""}` : yaml;
}

function dependenciesFind(
  value: unknown,
  sourceState: StateFile,
  files: PromotionResource[],
): Array<{ type: ResourceType; id: string }> {
  const lookup = new Map(
    files.map((file) => [`${file.type}:${file.id}`, file]),
  );
  const references: Array<{ type: ResourceType; id: string }> = [];
  const reverse: Record<ResourceType, Map<string, string>> = {} as Record<
    ResourceType,
    Map<string, string>
  >;
  for (const type of Object.keys(FOLDER_MAP) as ResourceType[])
    reverse[type] = new Map(
      Object.entries(sourceState[type]).map(([id, entry]) => [entry.uuid, id]),
    );
  function visit(current: unknown, key?: string): void {
    if (typeof current === "string" && key && REFERENCE_FIELDS[key]) {
      const type = REFERENCE_FIELDS[key];
      const clean = current.split("##")[0]?.trim() ?? "";
      const id = reverse[type].get(clean) ?? clean;
      if (!lookup.has(`${type}:${id}`))
        throw new Error(
          `Referenced managed dependency is missing from source: ${type}/${id}`,
        );
      references.push({ type, id });
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key);
      return;
    }
    if (current && typeof current === "object")
      for (const [childKey, child] of Object.entries(current))
        visit(child, childKey);
  }
  visit(value);
  return references;
}

export async function promotionPlanBuild(
  options: PromotionPlanOptions,
): Promise<PromotionPlan> {
  const bindings = options.bindings ?? DEFAULT_BINDINGS;
  const allSource = await resourcesRead(options.rootDir, options.source);
  const target = await resourcesRead(options.rootDir, options.target);
  const targetIgnore = await ignorePatternsRead(
    options.rootDir,
    options.target,
  );
  const selectedSource = allSource.filter(
    (file) =>
      selected(file.path, options.patterns) &&
      !ignored(file.path, targetIgnore),
  );
  const selectedTarget = target.filter(
    (file) =>
      selected(file.path, options.patterns) &&
      !ignored(file.path, targetIgnore),
  );
  const stateConfirmsDeletion = (
    Object.keys(FOLDER_MAP) as ResourceType[]
  ).some((type) =>
    Object.keys(options.sourceState[type]).some((id) =>
      VALID_EXTENSIONS.some((extension) =>
        selected(`${FOLDER_MAP[type]}/${id}${extension}`, options.patterns),
      ),
    ),
  );
  if (
    selectedSource.length === 0 &&
    selectedTarget.length > 0 &&
    !stateConfirmsDeletion &&
    !options.allowEmptySourceDeletion
  )
    throw new Error(
      "Refusing an empty-source mirror deletion without matching source state",
    );
  const wanted = new Map(
    selectedSource.map((file) => [`${file.type}:${file.id}`, file]),
  );
  const queue = [...wanted.values()];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const parsed = await resourceData(file, options.rootDir, options.source);
    for (const dependency of dependenciesFind(
      parsed.data,
      options.sourceState,
      allSource,
    )) {
      const key = `${dependency.type}:${dependency.id}`;
      const dependencyFile = allSource.find(
        (candidate) => `${candidate.type}:${candidate.id}` === key,
      );
      if (dependencyFile && ignored(dependencyFile.path, targetIgnore))
        throw new Error(
          `Referenced dependency is ignored by target .vapi-ignore: ${dependencyFile.path}`,
        );
      if (dependencyFile && !wanted.has(key)) {
        wanted.set(key, dependencyFile);
        queue.push(dependencyFile);
      }
    }
  }
  const resolved = await bindingsResolve(
    options.rootDir,
    options.source,
    options.target,
    options.sourceState,
  );
  const targetByPath = new Map(target.map((file) => [file.path, file]));
  const sourcePaths = new Set([...wanted.values()].map((file) => file.path));
  const changes: PromotionChange[] = [];
  for (const file of wanted.values()) {
    const parsed = await resourceData(file, options.rootDir, options.source);
    const canonical = referencesCanonicalize(parsed.data, options.sourceState);
    const transformed = bindingsApply(
      canonical,
      bindings,
      resolved,
      options.targetState,
    );
    if (
      extname(file.path) === ".ts" &&
      !isDeepStrictEqual(parsed.data, transformed)
    )
      throw new Error(
        `TypeScript resource ${file.path} contains org-specific references; use logical aliases or YAML/Markdown so promotion can rewrite them safely`,
      );
    const content =
      extname(file.path) === ".ts" ||
      isDeepStrictEqual(parsed.data, transformed)
        ? file.content
        : renderContent(transformed, file.path, parsed.body);
    const existing = targetByPath.get(file.path);
    if (!existing || existing.content !== content)
      changes.push({
        kind: existing ? "update" : "create",
        path: file.path,
        content,
      });
  }
  for (const file of target)
    if (
      selected(file.path, options.patterns) &&
      !ignored(file.path, targetIgnore) &&
      !sourcePaths.has(file.path)
    )
      changes.push({ kind: "delete", path: file.path });
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return { rootDir: options.rootDir, target: options.target, changes };
}

export async function promotionPlanApply(plan: PromotionPlan): Promise<void> {
  const base = join(plan.rootDir, "resources", plan.target);
  for (const change of plan.changes) {
    const path = join(base, change.path);
    if (change.kind === "delete") {
      await rm(path, { force: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, change.content ?? "");
  }
}

export function promotionStateParse(content: string): StateFile {
  const raw = object(JSON.parse(content), "state file");
  const empty: StateFile = {
    credentials: {},
    assistants: {},
    structuredOutputs: {},
    tools: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
  for (const type of Object.keys(empty) as ResourceType[]) {
    const section = raw[type];
    if (!section || typeof section !== "object" || Array.isArray(section))
      continue;
    for (const [id, entry] of Object.entries(section)) {
      const uuid =
        typeof entry === "string" ? entry : object(entry, `${type}.${id}`).uuid;
      if (typeof uuid === "string") empty[type][id] = { uuid };
    }
  }
  return empty;
}
