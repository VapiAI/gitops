// Config-free resource file reading.
//
// resources.ts and config.ts bind one org at import time (config.ts parses
// argv and exits). The PR check reads an org's files without that, so the
// scan/parse/ignore logic lives here, parameterised on the directory, and
// resources.ts and config.ts delegate to it. Push and the check therefore
// read files the same way.

import { existsSync, readFileSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { extname, join, relative } from "path";
import { parse as parseYaml } from "yaml";
import { isBackupCopyFile } from "./slug-utils.ts";
import type { ResourceFile, ResourceType } from "./types.ts";

// Options bag for the load functions. `ignorePatterns` is the symmetric
// counterpart to pull's filter: when present, ids matching any pattern are
// dropped from the returned array (with a skip-log) before any caller sees
// them. Push wires this from `loadIgnorePatterns()`; pass `[]` (or omit) to
// preserve the pre-change behavior.
export interface LoadOptions {
  ignorePatterns?: string[];
  // Suppress per-file "📦 Loaded" / "📁 No <type> directory" chatter. Used by
  // scoped (single-file / --type) pushes: the FULL set is still loaded for
  // reference resolution, but printing every file makes the blast radius look
  // larger than it is — the caller prints the scoped selection instead.
  quiet?: boolean;
}

// Map resource types to their folder paths (relative to resources/)
export const FOLDER_MAP: Record<ResourceType, string> = {
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

// Single source of truth for resource file extensions. Imported by
// `recanonicalize.ts` so the precondition-5 "both files exist" check
// stays in lockstep with the loader — without this, a `.ts`-authored
// resource paired with a UUID-suffixed `.ts` twin would be invisible to
// the safety check and silently allow the data-loss shape the
// recanonicalize header explicitly refuses.
export const VALID_EXTENSIONS: readonly string[] = [
  ".yml",
  ".yaml",
  ".ts",
  ".md",
];

/**
 * Parse a markdown file with YAML frontmatter
 * Format:
 * ---
 * key: value
 * ---
 * Markdown content (becomes system prompt)
 */
export function parseFrontmatter(content: string): {
  config: Record<string, unknown>;
  body: string;
} {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error(
      "Invalid frontmatter format - expected YAML between --- delimiters",
    );
  }

  const yamlContent = match[1] ?? "";
  const body = match[2] ?? "";
  const config = parseYaml(yamlContent) as Record<string, unknown>;

  return { config, body: body.trim() };
}

// Parse a `.md` resource: frontmatter is the config and a non-empty body
// becomes the system message, replacing any system message in the
// frontmatter. This is what push sends, so the check must build the same.
export function markdownResourceParse(
  content: string,
): Record<string, unknown> {
  const { config, body } = parseFrontmatter(content);

  if (body) {
    const model = (config.model as Record<string, unknown>) || {};
    const existingMessages = Array.isArray(model.messages)
      ? model.messages
      : [];
    model.messages = [
      { role: "system", content: body },
      ...existingMessages.filter((m: { role?: string }) => m.role !== "system"),
    ];
    config.model = model;
  }

  return config;
}

export function parseResourceDataFromFile(
  filePath: string,
): Record<string, unknown> {
  const ext = extname(filePath);

  if (ext === ".md") {
    return markdownResourceParse(readFileSync(filePath, "utf-8"));
  }

  const content = readFileSync(filePath, "utf-8");
  const data = parseYaml(content) as Record<string, unknown>;
  if (data === null || data === undefined) {
    throw new Error(`Empty or invalid YAML in ${filePath}`);
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`YAML must be an object in ${filePath}`);
  }
  return data;
}

/**
 * Recursively scan a directory for resource files (.yml, .yaml, .ts)
 * Warns about unsupported files found in resource directories
 */
export async function scanDirectory(
  dir: string,
  baseDir: string,
): Promise<string[]> {
  // Sort entries so iteration order is identical across filesystems/CI runners.
  // readdir() returns entries in OS-dependent order (APFS sorts, ext4 doesn't),
  // and downstream push order affects which resource is created first when
  // multiple files declare the same resourceId — non-determinism makes that
  // bug class hard to reproduce.
  const entries = (await readdir(dir)).slice().sort();
  const files: string[] = [];

  for (const entry of entries) {
    // Skip hidden files and directories (e.g., .DS_Store, .gitkeep)
    if (entry.startsWith(".")) {
      continue;
    }

    // Skip dashboard-backup siblings written by the push conflict prompt
    // ("create local copy + manual merge"). They're reference material for a
    // hand-merge, not resources — loading one would re-create it on the
    // platform as a duplicate.
    if (isBackupCopyFile(entry)) {
      continue;
    }

    const fullPath = join(dir, entry);
    const stats = await stat(fullPath);
    const relativePath = relative(baseDir, fullPath);

    if (stats.isDirectory()) {
      // Recursively scan subdirectories
      const subFiles = await scanDirectory(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      const ext = extname(entry);
      if (VALID_EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      } else {
        // Warn about unsupported files
        console.warn(
          `  ⚠️  Skipping unsupported file: ${relativePath} (expected ${VALID_EXTENSIONS.join(", ")})`,
        );
      }
    }
  }

  return files;
}

// Load every resource of one type from `<resourcesDir>/<folder>/`.
// `loadResources` is this with the configured org's directory.
export async function resourceDirLoad<T>(
  type: ResourceType,
  resourcesDir: string,
  options: LoadOptions = {},
): Promise<ResourceFile<T>[]> {
  const folderPath = FOLDER_MAP[type];
  const resourceDir = join(resourcesDir, folderPath);
  const ignorePatterns = options.ignorePatterns ?? [];

  if (!existsSync(resourceDir)) {
    if (!options.quiet)
      console.log(`📁 No ${type} directory found, skipping...`);
    return [];
  }

  const filePaths = await scanDirectory(resourceDir, resourceDir);
  const resources: ResourceFile<T>[] = [];
  const seenIds = new Map<string, string>(); // resourceId -> filePath

  for (const filePath of filePaths) {
    const ext = extname(filePath);

    // Compute resourceId as path relative to the resource type directory, without extension
    // e.g., /resources/<org>/assistants/support/intake.yml → support/intake
    // e.g., /resources/<org>/assistants/inbound-support.yml → inbound-support
    const relativePath = relative(resourceDir, filePath);
    const resourceId = relativePath.slice(0, -ext.length);

    // Symmetric ignore: drop matched ids before duplicate-detection and
    // parsing so the rest of the pipeline never sees the file. Caller passes
    // `[]` (or omits) to opt out — preserves the pre-change behavior.
    if (ignorePatterns.length > 0) {
      const matched = matchesIgnore(folderPath, resourceId, ignorePatterns);
      if (matched) {
        console.log(`  🚫 ${resourceId} (matched .vapi-ignore: ${matched})`);
        continue;
      }
    }

    // Check for duplicate resourceIds (e.g., foo.yml and foo.yaml in same directory)
    if (seenIds.has(resourceId)) {
      throw new Error(
        `Duplicate resource ID "${resourceId}" found:\n` +
          `  - ${seenIds.get(resourceId)}\n` +
          `  - ${filePath}\n` +
          `Each resource must have a unique path-based identifier.`,
      );
    }
    seenIds.set(resourceId, filePath);

    let data: T;
    if (ext === ".ts") {
      // Dynamic import for TypeScript files
      try {
        const module = await import(filePath);
        data = module.default as T;
        if (data === undefined) {
          throw new Error(`No default export found in ${relativePath}`);
        }
      } catch (error) {
        throw new Error(
          `Failed to import TypeScript resource "${relativePath}": ${error}`,
        );
      }
    } else if (ext === ".md") {
      // Parse Markdown files with YAML frontmatter (for assistants with system prompts)
      try {
        const content = await readFile(filePath, "utf-8");
        data = markdownResourceParse(content) as T;
      } catch (error) {
        throw new Error(
          `Failed to parse Markdown resource "${relativePath}": ${error}`,
        );
      }
    } else {
      // Parse YAML files
      try {
        const content = await readFile(filePath, "utf-8");
        data = parseYaml(content) as T;
        if (data === null || data === undefined) {
          throw new Error(`Empty or invalid YAML`);
        }
        if (typeof data !== "object" || Array.isArray(data)) {
          throw new Error(
            `YAML must be an object, got ${Array.isArray(data) ? "array" : typeof data}`,
          );
        }
      } catch (error) {
        throw new Error(
          `Failed to parse YAML resource "${relativePath}": ${error}`,
        );
      }
    }

    resources.push({ resourceId, filePath, data });
    if (!options.quiet) console.log(`  📦 Loaded ${resourceId}`);
  }

  return resources;
}

export interface OrgResource {
  type: ResourceType;
  id: string;
  filePath: string;
  data: Record<string, unknown>;
}

export interface OrgResourcesReadOptions {
  // Defaults to the org's own `.vapi-ignore`, which is what push applies.
  ignorePatterns?: string[];
  // Defaults to true: callers that aren't push don't want per-file logs.
  quiet?: boolean;
}

// Read every resource under `<rootDir>/resources/<org>/`, keyed `type:id`.
export async function orgResourcesRead(
  rootDir: string,
  org: string,
  options: OrgResourcesReadOptions = {},
): Promise<Map<string, OrgResource>> {
  const resourcesDir = join(rootDir, "resources", org);
  const loadOptions: LoadOptions = {
    ignorePatterns: options.ignorePatterns ?? ignorePatternsRead(resourcesDir),
    quiet: options.quiet ?? true,
  };
  const resources = new Map<string, OrgResource>();
  for (const type of Object.keys(FOLDER_MAP) as ResourceType[]) {
    const files = await resourceDirLoad<Record<string, unknown>>(
      type,
      resourcesDir,
      loadOptions,
    );
    for (const file of files) {
      resources.set(`${type}:${file.resourceId}`, {
        type,
        id: file.resourceId,
        filePath: file.filePath,
        data: file.data,
      });
    }
  }
  return resources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ignore Patterns (.vapi-ignore)
//
// Resources matching any pattern in resources/<env>/.vapi-ignore are skipped
// during pull (never written, never tracked). This is the explicit opt-out
// mechanism for resources that exist on the dashboard but should not be
// managed by this repo.
//
// Pattern syntax (gitignore-flavored, simplified):
//   - Matches against `<folderPath>/<resourceId>` (no extension)
//     e.g. `assistants/ab-assistant-56b80091`
//   - `*`  matches any run of characters within a single path segment
//   - `**` matches across path segments (zero or more)
//   - Lines starting with `#` are comments
//   - Blank lines are ignored
//   - Leading `!` is reserved for future negation; treated as a comment today
// ─────────────────────────────────────────────────────────────────────────────

// Read `<resourcesDir>/.vapi-ignore`; a missing file means no patterns.
export function ignorePatternsRead(resourcesDir: string): string[] {
  const path = join(resourcesDir, ".vapi-ignore");
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("#") && !line.startsWith("!"),
    );
}

// Convert a gitignore-flavored glob to a RegExp. We keep the implementation
// intentionally small (no node_modules). Also matches check trigger paths.
export function compilePattern(pattern: string): RegExp {
  // Escape regex metacharacters except the glob ones we handle explicitly.
  // `*` and `?` are translated below; everything else is literal.
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      // `**` → match any characters including path separators
      // `*`  → match any characters within a single segment (no `/`)
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++; // consume the second `*`
      } else {
        regex += "[^/]*";
      }
    } else if (c === "?") {
      regex += "[^/]";
    } else if ("\\^$.|+(){}[]".includes(c as string)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

// Check whether a resource at `<folderPath>/<resourceId>` matches the ignore list.
// Returns the matched pattern (truthy) or null.
export function matchesIgnore(
  folderPath: string,
  resourceId: string,
  patterns: string[],
): string | null {
  if (patterns.length === 0) return null;
  const target = `${folderPath}/${resourceId}`;
  for (const pattern of patterns) {
    if (compilePattern(pattern).test(target)) return pattern;
  }
  return null;
}
