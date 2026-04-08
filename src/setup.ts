import { existsSync, readdirSync } from "fs";
import { mkdir, writeFile, readFile, rm, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { input, password, confirm, select } from "@inquirer/prompts";
import searchableCheckbox from "./searchableCheckbox.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");
const VAPI_REGIONS: Record<string, string> = {
  us: "https://api.vapi.ai",
  eu: "https://api.eu.vapi.ai",
};
let vapiBaseUrl = VAPI_REGIONS.us!;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

interface ResourceTypeDef {
  key: string;
  label: string;
  endpoint: string;
}

const RESOURCE_TYPES: ResourceTypeDef[] = [
  { key: "assistants", label: "Assistants", endpoint: "/assistant" },
  { key: "tools", label: "Tools", endpoint: "/tool" },
  { key: "squads", label: "Squads", endpoint: "/squad" },
  {
    key: "structuredOutputs",
    label: "Structured Outputs",
    endpoint: "/structured-output",
  },
  {
    key: "personalities",
    label: "Personalities",
    endpoint: "/eval/simulation/personality",
  },
  {
    key: "scenarios",
    label: "Scenarios",
    endpoint: "/eval/simulation/scenario",
  },
  { key: "simulations", label: "Simulations", endpoint: "/eval/simulation" },
  {
    key: "simulationSuites",
    label: "Simulation Suites",
    endpoint: "/eval/simulation/suite",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Terminal helpers
// ─────────────────────────────────────────────────────────────────────────────

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// ─────────────────────────────────────────────────────────────────────────────
// API client
// ─────────────────────────────────────────────────────────────────────────────

async function apiGet(token: string, endpoint: string): Promise<unknown> {
  const response = await fetch(`${vapiBaseUrl}${endpoint}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `API GET ${endpoint} failed (${response.status}): ${text}`,
    );
  }

  return response.json();
}

async function validateToken(token: string): Promise<boolean> {
  try {
    await apiGet(token, "/assistant?limit=1");
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource fetching
// ─────────────────────────────────────────────────────────────────────────────

interface ResourceSnapshot {
  key: string;
  label: string;
  count: number;
  resources: Record<string, unknown>[];
}

function normaliseList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (
    data &&
    typeof data === "object" &&
    "results" in data &&
    Array.isArray((data as Record<string, unknown>).results)
  ) {
    return (data as Record<string, unknown>).results as Record<
      string,
      unknown
    >[];
  }
  return [];
}

async function fetchAllResourceSnapshots(
  token: string,
): Promise<ResourceSnapshot[]> {
  const results = await Promise.all(
    RESOURCE_TYPES.map(async (type): Promise<ResourceSnapshot> => {
      try {
        const data = await apiGet(token, type.endpoint);
        const list = normaliseList(data);
        return {
          key: type.key,
          label: type.label,
          count: list.length,
          resources: list,
        };
      } catch {
        return { key: type.key, label: type.label, count: 0, resources: [] };
      }
    }),
  );
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slug helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency detection — scan selected resources for UUID references
// to resources that aren't yet selected
// ─────────────────────────────────────────────────────────────────────────────

function detectMissingDependencies(
  snapshots: ResourceSnapshot[],
  selectedIds: Set<string>,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();

  const addRef = (type: string, value: unknown) => {
    if (typeof value !== "string" || !UUID_RE.test(value)) return;
    if (selectedIds.has(`${type}::${value}`)) return;
    if (!refs.has(type)) refs.set(type, new Set());
    refs.get(type)!.add(value);
  };

  for (const snap of snapshots) {
    for (const r of snap.resources) {
      const id = r.id as string;
      if (!selectedIds.has(`${snap.key}::${id}`)) continue;

      const model = r.model as Record<string, unknown> | undefined;
      if (model && Array.isArray(model.toolIds)) {
        for (const tid of model.toolIds) addRef("tools", tid);
      }

      if (Array.isArray(r.toolIds)) {
        for (const tid of r.toolIds) addRef("tools", tid);
      }

      const ap = r.artifactPlan as Record<string, unknown> | undefined;
      if (ap && Array.isArray(ap.structuredOutputIds)) {
        for (const sid of ap.structuredOutputIds)
          addRef("structuredOutputs", sid);
      }

      if (Array.isArray(r.members)) {
        for (const m of r.members as Record<string, unknown>[]) {
          addRef("assistants", m.assistantId);
          if (Array.isArray(m.assistantDestinations)) {
            for (const d of m.assistantDestinations as Record<
              string,
              unknown
            >[]) {
              addRef("assistants", d.assistantId);
            }
          }
        }
      }

      if (Array.isArray(r.destinations)) {
        for (const d of r.destinations as Record<string, unknown>[]) {
          addRef("assistants", d.assistantId);
        }
      }

      if (Array.isArray(r.assistantIds)) {
        for (const aid of r.assistantIds) addRef("assistants", aid);
      }

      addRef("personalities", r.personalityId);
      addRef("scenarios", r.scenarioId);

      if (Array.isArray(r.simulationIds)) {
        for (const sid of r.simulationIds) addRef("simulations", sid);
      }

      if (Array.isArray(r.evaluations)) {
        for (const ev of r.evaluations as Record<string, unknown>[]) {
          addRef("structuredOutputs", ev.structuredOutputId);
        }
      }
    }
  }

  // Only keep refs to resources that actually exist in our snapshots
  const knownIds = new Set<string>();
  for (const snap of snapshots) {
    for (const r of snap.resources) {
      knownIds.add(`${snap.key}::${r.id as string}`);
    }
  }

  const missing = new Map<string, Set<string>>();
  for (const [type, uuids] of refs) {
    const existing = new Set<string>();
    for (const uuid of uuids) {
      if (knownIds.has(`${type}::${uuid}`)) existing.add(uuid);
    }
    if (existing.size > 0) missing.set(type, existing);
  }
  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// File system helpers
// ─────────────────────────────────────────────────────────────────────────────

async function writeEnvFile(
  slug: string,
  token: string,
  baseUrl: string,
): Promise<void> {
  const envPath = join(BASE_DIR, `.env.${slug}`);
  let content = `VAPI_TOKEN=${token}\n`;
  if (baseUrl !== VAPI_REGIONS.us) {
    content += `VAPI_BASE_URL=${baseUrl}\n`;
  }
  await writeFile(envPath, content);
}

async function deleteExistingOrg(slug: string): Promise<void> {
  const resourceDir = join(BASE_DIR, "resources", slug);
  const stateFile = join(BASE_DIR, `.vapi-state.${slug}.json`);

  if (existsSync(resourceDir)) {
    await rm(resourceDir, { recursive: true, force: true });
  }
  if (existsSync(stateFile)) {
    await rm(stateFile);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull integration
// ─────────────────────────────────────────────────────────────────────────────

function invokePull(slug: string, types: string[]): void {
  const typeArgs = types.flatMap((t) => ["--type", t]);
  const cmd = ["tsx", "src/pull.ts", slug, "--force", ...typeArgs].join(" ");
  const binDir = join(BASE_DIR, "node_modules", ".bin");
  const sep = process.platform === "win32" ? ";" : ":";

  execSync(cmd, {
    cwd: BASE_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${binDir}${sep}${process.env.PATH ?? ""}`,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-pull cleanup — remove resources that were pulled but not selected
// ─────────────────────────────────────────────────────────────────────────────

async function pruneUnselected(
  slug: string,
  selectedIds: Set<string>,
): Promise<number> {
  const stateFilePath = join(BASE_DIR, `.vapi-state.${slug}.json`);
  if (!existsSync(stateFilePath)) return 0;

  const raw = await readFile(stateFilePath, "utf-8");
  const state = JSON.parse(raw) as Record<string, Record<string, string>>;

  // Build set of selected UUIDs per type
  const selectedByType = new Map<string, Set<string>>();
  for (const id of selectedIds) {
    const sep = id.indexOf("::");
    const typeKey = id.substring(0, sep);
    const uuid = id.substring(sep + 2);
    if (!selectedByType.has(typeKey)) selectedByType.set(typeKey, new Set());
    selectedByType.get(typeKey)!.add(uuid);
  }

  let pruned = 0;
  const resourceDir = join(BASE_DIR, "resources", slug);

  for (const [typeKey, entries] of Object.entries(state)) {
    if (typeof entries !== "object" || entries === null) continue;

    const wantedUUIDs = selectedByType.get(typeKey);
    if (!wantedUUIDs) {
      // Type wasn't selected at all but was pulled (e.g. credentials) — leave it
      continue;
    }

    const typeDir = join(resourceDir, typeKey);
    const slugsToRemove: string[] = [];

    for (const [fileSlug, uuid] of Object.entries(entries)) {
      if (wantedUUIDs.has(uuid)) continue;

      // Delete the resource file (could be .md or .yml)
      if (existsSync(typeDir)) {
        const files = readdirSync(typeDir);
        for (const f of files) {
          const nameWithoutExt = f.replace(/\.[^.]+$/, "");
          if (nameWithoutExt === fileSlug) {
            await unlink(join(typeDir, f));
            pruned++;
            break;
          }
        }
      }

      slugsToRemove.push(fileSlug);
    }

    for (const s of slugsToRemove) {
      delete entries[s];
    }
  }

  // Write cleaned state file
  await writeFile(stateFilePath, JSON.stringify(state, null, 2) + "\n");
  return pruned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

function resourceDisplayName(r: Record<string, unknown>): string {
  // Top-level name (assistants, squads, structured outputs, simulations, etc.)
  if (typeof r.name === "string" && r.name) return r.name;

  // Tools: meaningful name is in function.name, type gives context
  const fn = r.function as Record<string, unknown> | undefined;
  const fnName = typeof fn?.name === "string" ? fn.name : "";
  const rType = typeof r.type === "string" ? r.type : "";

  if (fnName && rType) return `${fnName} (${rType})`;
  if (fnName) return fnName;
  if (rType) return `${rType} (${(r.id as string).slice(0, 8)}…)`;

  // Last resort
  return r.id as string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main wizard
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!existsSync(join(BASE_DIR, "node_modules"))) {
    console.log(c.dim("\n  Installing dependencies...\n"));
    execSync("npm install", { cwd: BASE_DIR, stdio: "inherit" });
  }

  console.log("");
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log(c.bold("  Vapi GitOps — Setup Wizard"));
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log("");

  // ── Step 1: API key + region ────────────────────────────────────────

  let trimmedKey = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const apiKey = await password({
      message: "Paste your Vapi private API key",
      mask: "•",
      validate: (value) => {
        if (!value.trim()) return "API key is required";
        return true;
      },
    });

    trimmedKey = apiKey.trim();
    console.log(c.dim(`  Validating against ${vapiBaseUrl}…`));

    const valid = await validateToken(trimmedKey);
    if (valid) {
      const region = vapiBaseUrl === VAPI_REGIONS.eu ? "EU" : "US";
      console.log(c.green(`  ✓ Connected to Vapi (${region})\n`));
      break;
    }

    console.log(
      c.red("  ✗ Could not authenticate — invalid key or wrong region.\n"),
    );

    const recovery = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Try a different API key", value: "retry" as const },
        {
          name: `Switch to ${vapiBaseUrl === VAPI_REGIONS.eu ? "US" : "EU"} region and retry`,
          value: "switch" as const,
        },
        { name: "Cancel setup", value: "cancel" as const },
      ],
    });

    if (recovery === "cancel") {
      console.log(c.dim("\n  Setup cancelled."));
      process.exit(0);
    }

    if (recovery === "switch") {
      vapiBaseUrl =
        vapiBaseUrl === VAPI_REGIONS.eu ? VAPI_REGIONS.us! : VAPI_REGIONS.eu!;
      console.log(c.dim(`  Switched to ${vapiBaseUrl}\n`));
      // Re-validate same key against the new region
      console.log(c.dim(`  Validating against ${vapiBaseUrl}…`));
      const retryValid = await validateToken(trimmedKey);
      if (retryValid) {
        const region = vapiBaseUrl === VAPI_REGIONS.eu ? "EU" : "US";
        console.log(c.green(`  ✓ Connected to Vapi (${region})\n`));
        break;
      }
      console.log(
        c.red("  ✗ Still could not authenticate. Try a different key.\n"),
      );
    }

    // "retry" or failed switch → loop back to password prompt
  }

  // ── Step 2: Folder slug ───────────────────────────────────────────────

  const rawSlug = await input({
    message: "Folder name for this org (e.g. acme-corp, acme-prod)",
    validate: (value) => {
      const slug = slugify(value);
      if (!slug || !SLUG_RE.test(slug)) {
        return "Must be lowercase alphanumeric with hyphens (e.g. my-org-name)";
      }
      return true;
    },
    transformer: (value) => {
      const slug = slugify(value);
      if (slug && slug !== value) return `${value} → ${c.dim(slug)}`;
      return value;
    },
  });

  const slug = slugify(rawSlug);

  // Check if org already exists locally
  const resourceDir = join(BASE_DIR, "resources", slug);
  const stateFile = join(BASE_DIR, `.vapi-state.${slug}.json`);

  if (existsSync(resourceDir) || existsSync(stateFile)) {
    console.log(c.yellow(`\n  ⚠ Org "${slug}" already exists locally.`));

    const override = await confirm({
      message: "Override? (deletes existing files and re-pulls)",
      default: false,
    });

    if (!override) {
      console.log(
        `\n  Use ${c.cyan(`npm run pull -- ${slug}`)} to update existing resources.`,
      );
      process.exit(0);
    }

    console.log(c.dim("  Removing existing files..."));
    await deleteExistingOrg(slug);
    console.log(c.green("  ✓ Cleaned up\n"));
  } else {
    console.log(c.green(`\n  ✓ Will create: resources/${slug}/\n`));
  }

  // ── Step 3: Resource selection ────────────────────────────────────────

  console.log(c.dim("  Fetching available resources...\n"));

  const snapshots = await fetchAllResourceSnapshots(trimmedKey);
  const nonEmpty = snapshots.filter((s) => s.count > 0);

  if (nonEmpty.length === 0) {
    console.log(c.yellow("  No resources found in this org."));
    console.log("  Writing environment file only.\n");
    await writeEnvFile(slug, trimmedKey, vapiBaseUrl);
    await mkdir(resourceDir, { recursive: true });
    printSummary(slug);
    return;
  }

  const totalCount = nonEmpty.reduce((n, s) => n + s.count, 0);

  const scope = await select({
    message: "Which resources to download?",
    choices: [
      {
        name: `All (${totalCount} resources across ${nonEmpty.length} types)`,
        value: "all" as const,
      },
      { name: "Let me pick…", value: "pick" as const },
    ],
  });

  // selectedIds: "typeKey::resourceUUID"
  let selectedIds: Set<string>;

  if (scope === "pick") {
    const allChoices = nonEmpty.flatMap((snap) =>
      snap.resources.map((r) => ({
        value: `${snap.key}::${r.id as string}`,
        name: resourceDisplayName(r),
        group: snap.label,
        checked: false,
      })),
    );

    const picked = await searchableCheckbox({
      message: "Select resources",
      choices: allChoices,
      pageSize: 20,
    });

    selectedIds = new Set(picked);
  } else {
    // All resources
    selectedIds = new Set(
      nonEmpty.flatMap((snap) =>
        snap.resources.map((r) => `${snap.key}::${r.id as string}`),
      ),
    );
  }

  // ── Step 3b: Dependency detection (iterative) ─────────────────────────

  console.log(c.dim("\n  Checking dependencies...\n"));

  let iterations = 0;
  while (iterations < 5) {
    const missing = detectMissingDependencies(snapshots, selectedIds);
    if (missing.size === 0) break;

    console.log(
      c.yellow("  ⚠ Selected resources reference additional items:"),
    );
    for (const [type, uuids] of missing) {
      const def = RESOURCE_TYPES.find((t) => t.key === type);
      console.log(`    • ${uuids.size} ${def?.label ?? type}`);
    }
    console.log("");

    const includeDeps = await confirm({
      message: "Also download referenced resources?",
      default: true,
    });

    if (!includeDeps) break;

    for (const [type, uuids] of missing) {
      for (const uuid of uuids) {
        selectedIds.add(`${type}::${uuid}`);
      }
    }
    iterations++;
  }

  // Derive types to pull
  const typesToPull = [
    ...new Set([...selectedIds].map((v) => v.split("::")[0]!)),
  ];

  // Show final download list
  console.log("\n  Download list:");
  for (const snap of snapshots) {
    const typeSelected = [...selectedIds].filter((v) =>
      v.startsWith(`${snap.key}::`),
    ).length;
    if (typeSelected > 0) {
      console.log(
        `    ${c.green("✓")} ${snap.label} (${typeSelected}/${snap.count})`,
      );
    }
  }
  console.log("");

  // ── Step 4: Write env file & pull ─────────────────────────────────────

  await writeEnvFile(slug, trimmedKey, vapiBaseUrl);
  console.log(c.green(`  ✓ Created .env.${slug}\n`));

  console.log(c.bold("  Downloading...\n"));

  invokePull(slug, typesToPull);

  // Remove resources that were pulled but not selected
  if (scope === "pick") {
    const pruned = await pruneUnselected(slug, selectedIds);
    if (pruned > 0) {
      console.log(c.dim(`\n  Cleaned up ${pruned} unselected resource(s).`));
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────

  printSummary(slug);
}

function printSummary(slug: string): void {
  console.log("");
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log(c.bold("  ✅ Setup Complete!"));
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log("");
  console.log(`  📁 Resources:   resources/${slug}/`);
  console.log(`  🔑 Env file:    .env.${slug}`);
  console.log(`  📄 State file:  .vapi-state.${slug}.json`);
  console.log("");
  console.log("  Next steps:");
  console.log(
    `    ${c.cyan(`npm run pull -- ${slug}`)}             Pull latest from Vapi`,
  );
  console.log(
    `    ${c.cyan(`npm run push -- ${slug}`)}             Push local changes to Vapi`,
  );
  console.log(
    `    ${c.cyan(`npm run pull -- ${slug} --force`)}     Force overwrite local files`,
  );
  console.log("");
}

main().catch((error) => {
  console.error(
    c.red(
      `\n  ✗ Setup failed: ${error instanceof Error ? error.message : error}`,
    ),
  );
  process.exit(1);
});
