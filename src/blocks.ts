// Blocks: text and config shared between resource files.
//
// A prompt block is a Markdown file under templates/blocks/. A system prompt
// pulls it in with a line that holds only "@include <name>". A config block
// is a YAML file under templates/config/. Any mapping in a resource pulls it
// in with a "$include" key, and the mapping's own keys win over the block's.
//
// Both kinds are looked up in resources/<org>/templates/ first, then in
// templates/ at the repository root, so an org can replace a shared block.
// A block inside the org folder that includes its own name gets the shared
// one, which lets it extend the shared block rather than copy it.
//
// Expansion happens when a resource file is loaded, so validate, push, PR
// checks, drift hashes and the audit all see the expanded resource. Nothing
// inside a block is interpreted: Liquid variables reach Vapi as written.
// The marker is deliberately not Liquid, because Vapi renders "include" and
// "render" tags as nothing on a live call.
//
// Config-free, like resource-parse.ts, so every org can be read in one run.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { stateOrgDir } from "./state-paths.ts";

export const TEMPLATES_FOLDER = "templates";
export const INCLUDE_KEY = "$include";

const INCLUDE_LINE = /^[ \t]*@include[ \t]+(\S+)[ \t]*\r?$/;
const INCLUDE_LINE_ANYWHERE = /^[ \t]*@include[ \t]+\S+[ \t]*\r?$/m;
const BLOCK_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

interface BlockKind {
  label: string;
  folder: string;
  extensions: string[];
}

const PROMPT: BlockKind = {
  label: "prompt block",
  folder: "blocks",
  extensions: [".md"],
};
const CONFIG: BlockKind = {
  label: "config block",
  folder: "config",
  extensions: [".yml", ".yaml"],
};

// The two folders a block is looked up in, in order.
export interface BlockLayers {
  org: string;
  shared: string;
}

// <root>/resources/<org> → <root>/resources/<org>/templates and <root>/templates.
export function blockLayers(resourcesDir: string): BlockLayers {
  return {
    org: join(resourcesDir, TEMPLATES_FOLDER),
    shared: resolve(resourcesDir, "..", "..", TEMPLATES_FOLDER),
  };
}

// Block file → hash of its content, for every block a resource resolved to,
// nested ones included. Keys are paths inside a templates folder
// ("blocks/red-flags.md"), the same whichever layer supplied the file.
export type BlockUsage = Record<string, string>;

interface BlockFile {
  key: string;
  path: string;
  content: string;
}

interface Expansion {
  layers: BlockLayers;
  usage: Map<string, string>;
  // Block files being expanded right now, outermost first.
  stack: BlockFile[];
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSystemMessage(
  value: Mapping,
): value is Mapping & { content: string } {
  return value.role === "system" && typeof value.content === "string";
}

function blockFind(
  kind: BlockKind,
  name: string,
  expansion: Expansion,
): BlockFile {
  if (!BLOCK_NAME.test(name))
    throw new Error(
      `Invalid ${kind.label} name "${name}": use the file name without its extension, for example "red-flags" or "safety/red-flags"`,
    );
  const { layers, stack } = expansion;
  const from = stack[stack.length - 1]?.path;
  const root = dirname(layers.shared);
  const searched: string[] = [];
  for (const layer of [layers.org, layers.shared]) {
    for (const extension of kind.extensions) {
      const path = join(layer, kind.folder, `${name}${extension}`);
      // An org block that includes its own name extends the shared one.
      if (layer === layers.org && path === from) continue;
      searched.push(relative(root, path));
      if (!existsSync(path)) continue;
      const block = {
        key: `${kind.folder}/${name}${extension}`,
        path,
        content: readFileSync(path, "utf8"),
      };
      if (stack.some((open) => open.path === path))
        throw new Error(
          `Blocks include each other in a loop: ${[...stack, block].map((open) => relative(root, open.path)).join(" → ")}`,
        );
      // An org block that extends the shared one uses both files.
      const hash = createHash("sha256").update(block.content);
      const outer = expansion.usage.get(block.key);
      if (outer !== undefined) hash.update(outer);
      expansion.usage.set(block.key, hash.digest("hex").slice(0, 16));
      return block;
    }
  }
  throw new Error(
    `Unknown ${kind.label} "${name}". Looked for:\n${searched.map((path) => `  - ${path}`).join("\n")}`,
  );
}

function blockExpand<T>(
  block: BlockFile,
  expansion: Expansion,
  expand: () => T,
): T {
  expansion.stack.push(block);
  try {
    return expand();
  } finally {
    expansion.stack.pop();
  }
}

function textExpand(text: string, expansion: Expansion): string {
  if (!INCLUDE_LINE_ANYWHERE.test(text)) return text;
  return text
    .split("\n")
    .map((line) => {
      const name = line.match(INCLUDE_LINE)?.[1];
      if (name === undefined) return line;
      const block = blockFind(PROMPT, name, expansion);
      // The block's own text only: no byte-order mark, no blank lines around it.
      const body = block.content
        .replace(/^\uFEFF/, "")
        .replace(/^(?:[ \t]*\r?\n)+/, "")
        .trimEnd();
      return blockExpand(block, expansion, () => textExpand(body, expansion));
    })
    .join("\n");
}

// Two blocks included side by side: mappings combine, and anything else set
// by both must be identical, so the result never depends on their order.
function blocksCombine(
  left: Mapping,
  right: Mapping,
  names: string,
  path: string[],
): Mapping {
  const combined: Mapping = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = combined[key];
    if (!(key in combined)) combined[key] = value;
    else if (isMapping(existing) && isMapping(value))
      combined[key] = blocksCombine(existing, value, names, [...path, key]);
    else if (!isDeepStrictEqual(existing, value))
      throw new Error(
        `Config blocks ${names} both set "${[...path, key].join(".")}" to different values. Set it in one block, or in the file that includes them.`,
      );
  }
  return combined;
}

// The including mapping over its blocks: mappings merge key by key, and any
// other value the file sets (a list included) replaces the block's whole.
function fileOverBlock(block: Mapping, file: Mapping): Mapping {
  const merged: Mapping = { ...block };
  for (const [key, value] of Object.entries(file)) {
    const inherited = merged[key];
    merged[key] =
      isMapping(inherited) && isMapping(value)
        ? fileOverBlock(inherited, value)
        : value;
  }
  return merged;
}

function includeNames(value: unknown): string[] {
  const names: unknown[] = Array.isArray(value) ? value : [value];
  if (
    names.length === 0 ||
    names.some((name) => typeof name !== "string" || name === "")
  )
    throw new Error(
      `"${INCLUDE_KEY}" takes a config block name or a list of names, got ${JSON.stringify(value)}`,
    );
  if (new Set(names).size !== names.length)
    throw new Error(`"${INCLUDE_KEY}" lists the same config block twice`);
  return names as string[];
}

function configExpand(value: unknown, expansion: Expansion): unknown {
  if (Array.isArray(value))
    return value.map((item) => configExpand(item, expansion));
  if (!isMapping(value)) return value;
  const own: Mapping = {};
  for (const [key, child] of Object.entries(value))
    if (key !== INCLUDE_KEY) own[key] = configExpand(child, expansion);
  if (!(INCLUDE_KEY in value)) return own;
  if ("<<" in value)
    throw new Error(
      `A mapping uses both "${INCLUDE_KEY}" and a YAML merge key ("<<"). The engine does not process merge keys; keep "${INCLUDE_KEY}" only.`,
    );
  const names = includeNames(value[INCLUDE_KEY]);
  const included = names.map((name) => {
    const block = blockFind(CONFIG, name, expansion);
    const parsed: unknown = parseYaml(block.content);
    if (parsed === null || parsed === undefined)
      throw new Error(`Config block "${name}" is empty`);
    return blockExpand(block, expansion, () => configExpand(parsed, expansion));
  });
  // On its own, "$include" stands for the block's value, whatever its shape.
  if (Object.keys(own).length === 0 && included.length === 1)
    return included[0];
  const quoted = names.map((name) => `"${name}"`).join(" and ");
  let combined: Mapping = {};
  for (const [index, block] of included.entries()) {
    if (!isMapping(block))
      throw new Error(
        `Config block "${names[index]}" is not a mapping, so it can only be included on its own: no other keys beside "${INCLUDE_KEY}", and no other block in the list.`,
      );
    combined = blocksCombine(combined, block, quoted, []);
  }
  return fileOverBlock(combined, own);
}

function promptsExpand(value: unknown, expansion: Expansion): unknown {
  if (Array.isArray(value))
    return value.map((item) => promptsExpand(item, expansion));
  if (!isMapping(value)) return value;
  const output: Mapping = {};
  for (const [key, child] of Object.entries(value))
    output[key] = promptsExpand(child, expansion);
  if (isSystemMessage(output))
    output.content = textExpand(output.content, expansion);
  return output;
}

// Whether a parsed resource file uses a block anywhere. Pull asks this of the
// file as written, before it decides whether it may rewrite that file.
export function blocksUsedIn(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(blocksUsedIn);
  if (!isMapping(value)) return false;
  if (INCLUDE_KEY in value) return true;
  if (isSystemMessage(value) && INCLUDE_LINE_ANYWHERE.test(value.content))
    return true;
  return Object.values(value).some(blocksUsedIn);
}

// Expand every block a parsed resource uses. A resource that uses none is
// returned as it came in.
export function blocksExpand<T>(
  data: T,
  layers: BlockLayers,
): { data: T; usage: BlockUsage } {
  if (!blocksUsedIn(data)) return { data, usage: {} };
  const expansion: Expansion = { layers, usage: new Map(), stack: [] };
  const expanded = promptsExpand(configExpand(data, expansion), expansion);
  const usage: BlockUsage = {};
  for (const key of [...expansion.usage.keys()].sort())
    usage[key] = expansion.usage.get(key)!;
  return { data: expanded as T, usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync record
//
// state/<org>/blocks.json records, for each resource that uses
// blocks, the block content it was last pushed with. Push writes it and it is
// committed. A resource whose blocks no longer match its entry still runs the
// old block text on the platform: that is what "npm run sync-blocks" lists
// and what promotion adds to its plan. The file text of such a resource has
// not changed, so nothing else in git shows that it needs a push.
// ─────────────────────────────────────────────────────────────────────────────

export function blocksRecordPath(rootDir: string, org: string): string {
  return join(stateOrgDir(rootDir, org), "blocks.json");
}

// "<type folder>/<resource id>" → the blocks it was pushed with.
export type BlocksRecord = Record<string, BlockUsage>;

export function blocksRecordRead(rootDir: string, org: string): BlocksRecord {
  const path = blocksRecordPath(rootDir, org);
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isMapping(parsed)) throw new Error(`${path} must hold a JSON object`);
  return parsed as BlocksRecord;
}

// The block files that differ between what a resource uses now and what it
// was last pushed with; empty when it is in sync.
export function blocksChanged(
  usage: BlockUsage,
  recorded: BlockUsage | undefined,
): string[] {
  const keys = new Set([...Object.keys(usage), ...Object.keys(recorded ?? {})]);
  return [...keys].filter((key) => usage[key] !== recorded?.[key]).sort();
}

// Record what the pushed resources were pushed with, and drop entries for
// resources that no longer exist or no longer use blocks. Entries for
// resources this push did not touch are kept: they may still be out of date.
export function blocksRecordUpdate(
  rootDir: string,
  org: string,
  current: Map<string, BlockUsage>,
  pushed: Iterable<string>,
): void {
  const before = blocksRecordRead(rootDir, org);
  const after: BlocksRecord = { ...before };
  for (const key of pushed) {
    const usage = current.get(key);
    if (usage) after[key] = usage;
  }
  for (const key of Object.keys(after)) {
    const usage = current.get(key);
    if (!usage || Object.keys(usage).length === 0) delete after[key];
  }
  if (isDeepStrictEqual(before, after)) return;
  const sorted: BlocksRecord = {};
  for (const key of Object.keys(after).sort()) sorted[key] = after[key]!;
  const path = blocksRecordPath(rootDir, org);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}
