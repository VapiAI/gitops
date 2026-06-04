import { type ResourceType, VALID_RESOURCE_TYPES } from "./types.ts";

export type DriftResolveMode = "ours" | "theirs" | "fail";
export type PathResolveMode = Exclude<DriftResolveMode, "fail">;

export interface DriftPathRule {
  path: string;
  mode: PathResolveMode;
}

export interface DriftResolveSelection {
  defaultMode?: DriftResolveMode;
  perResource: Map<string, DriftResolveMode>;
  perPath: Map<string, DriftPathRule[]>;
}

export function resourceResolveKey(
  resourceType: ResourceType,
  resourceId: string,
): string {
  return `${resourceType}/${resourceId}`;
}

export function formatResolveUsage(): string {
  return (
    "Use --resolve=ours|theirs|fail, " +
    "--resolve=<resourceType>/<resourceId>=ours|theirs|fail, or " +
    "--resolve-path=<resourceType>/<resourceId>:<path>=ours|theirs"
  );
}

function parseMode(value: string): DriftResolveMode {
  if (value === "ours" || value === "theirs" || value === "fail") {
    return value;
  }
  throw new Error(`Invalid resolve mode: ${value}. ${formatResolveUsage()}`);
}

function parsePathMode(value: string): PathResolveMode {
  const mode = parseMode(value);
  if (mode === "fail") {
    throw new Error(`Invalid path resolve mode: fail. ${formatResolveUsage()}`);
  }
  return mode;
}

function parseResourceRef(ref: string): {
  resourceType: ResourceType;
  resourceId: string;
} {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid resolve target: ${ref}. ${formatResolveUsage()}`);
  }

  const resourceType = ref.slice(0, slash);
  const resourceId = ref.slice(slash + 1);
  if (!VALID_RESOURCE_TYPES.includes(resourceType as ResourceType)) {
    throw new Error(
      `Invalid resolve resource type: ${resourceType}. ` +
        `Expected one of: ${VALID_RESOURCE_TYPES.join(", ")}`,
    );
  }

  return { resourceType: resourceType as ResourceType, resourceId };
}

function setUnique<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  label: string,
): void {
  if (map.has(key)) {
    throw new Error(`Duplicate ${label}: ${String(key)}`);
  }
  map.set(key, value);
}

export function parseDriftResolveSelection(
  args: string[],
  explicitDefaultMode?: DriftResolveMode,
): DriftResolveSelection {
  const selection: DriftResolveSelection = {
    defaultMode: explicitDefaultMode,
    perResource: new Map(),
    perPath: new Map(),
  };

  for (const arg of args) {
    if (arg.startsWith("--resolve-path=")) {
      const spec = arg.slice("--resolve-path=".length);
      const modeSeparator = spec.lastIndexOf("=");
      const pathSeparator = spec.indexOf(":");
      if (
        modeSeparator <= 0 ||
        pathSeparator <= 0 ||
        pathSeparator > modeSeparator
      ) {
        throw new Error(
          `Invalid --resolve-path value: ${spec}. ${formatResolveUsage()}`,
        );
      }

      const target = spec.slice(0, pathSeparator);
      const path = spec.slice(pathSeparator + 1, modeSeparator);
      const mode = parsePathMode(spec.slice(modeSeparator + 1));
      if (!path) {
        throw new Error(
          `Invalid --resolve-path value: ${spec}. Path is required.`,
        );
      }

      const { resourceType, resourceId } = parseResourceRef(target);
      const key = resourceResolveKey(resourceType, resourceId);
      const rules = selection.perPath.get(key) ?? [];
      if (rules.some((rule) => rule.path === path)) {
        throw new Error(`Duplicate path resolve rule: ${key}:${path}`);
      }
      rules.push({ path, mode });
      selection.perPath.set(key, rules);
      continue;
    }

    if (!arg.startsWith("--resolve=")) continue;

    const spec = arg.slice("--resolve=".length);
    const separator = spec.lastIndexOf("=");
    if (separator === -1) {
      const mode = parseMode(spec);
      if (selection.defaultMode && selection.defaultMode !== mode) {
        throw new Error(
          `Duplicate global --resolve mode: ${selection.defaultMode} and ${mode}`,
        );
      }
      selection.defaultMode = mode;
      continue;
    }

    const target = spec.slice(0, separator);
    const mode = parseMode(spec.slice(separator + 1));
    const { resourceType, resourceId } = parseResourceRef(target);
    const key = resourceResolveKey(resourceType, resourceId);
    setUnique(selection.perResource, key, mode, "resource resolve rule");
  }

  return selection;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function parsePath(path: string): Array<string | number> {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

function getPath(
  value: Record<string, unknown>,
  path: Array<string | number>,
): { exists: boolean; value?: unknown } {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === "number") {
      if (segment < 0 || segment >= current.length) return { exists: false };
      current = current[segment];
      continue;
    }
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      typeof segment === "string" &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return { exists: false };
  }
  return { exists: true, value: current };
}

function deletePath(
  target: Record<string, unknown>,
  path: Array<string | number>,
): void {
  if (path.length === 0) return;
  let current: unknown = target;
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      typeof segment === "string"
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return;
    }
    if (current === undefined || current === null) return;
  }

  const leaf = path[path.length - 1];
  if (Array.isArray(current) && typeof leaf === "number") {
    current.splice(leaf, 1);
  } else if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    typeof leaf === "string"
  ) {
    delete (current as Record<string, unknown>)[leaf];
  }
}

function setPath(
  target: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
): void {
  if (path.length === 0) return;
  let current: unknown = target;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    const next = path[i + 1]!;
    if (Array.isArray(current) && typeof segment === "number") {
      current[segment] ??= typeof next === "number" ? [] : {};
      current = current[segment];
      continue;
    }
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      typeof segment === "string"
    ) {
      const object = current as Record<string, unknown>;
      object[segment] ??= typeof next === "number" ? [] : {};
      current = object[segment];
      continue;
    }
    throw new Error(
      `Cannot set path through non-object segment: ${String(segment)}`,
    );
  }

  const leaf = path[path.length - 1];
  if (Array.isArray(current) && typeof leaf === "number") {
    current[leaf] = cloneJson(value);
    return;
  }
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    typeof leaf === "string"
  ) {
    (current as Record<string, unknown>)[leaf] = cloneJson(value);
    return;
  }
  throw new Error(`Cannot set path on non-object leaf: ${String(leaf)}`);
}

export function mergeResourceByPathRules(options: {
  localData: Record<string, unknown>;
  platformData: Record<string, unknown>;
  baseMode: PathResolveMode;
  rules: DriftPathRule[];
}): Record<string, unknown> {
  const { localData, platformData, baseMode, rules } = options;
  const merged = cloneJson(baseMode === "ours" ? localData : platformData);

  for (const rule of rules) {
    const source = rule.mode === "ours" ? localData : platformData;
    const parsedPath = parsePath(rule.path);
    const sourceValue = getPath(source, parsedPath);
    if (sourceValue.exists) {
      setPath(merged, parsedPath, sourceValue.value);
    } else {
      deletePath(merged, parsedPath);
    }
  }

  return merged;
}
