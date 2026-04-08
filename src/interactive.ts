import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative, extname } from "path";
import { fileURLToPath } from "url";
import { select } from "@inquirer/prompts";
import searchableCheckbox, { BACK_SENTINEL } from "./searchableCheckbox.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

interface ResourceTypeDef {
  key: string;
  label: string;
  endpoint: string;
  folder: string;
}

const RESOURCE_TYPES: ResourceTypeDef[] = [
  {
    key: "assistants",
    label: "Assistants",
    endpoint: "/assistant",
    folder: "assistants",
  },
  { key: "tools", label: "Tools", endpoint: "/tool", folder: "tools" },
  { key: "squads", label: "Squads", endpoint: "/squad", folder: "squads" },
  {
    key: "structuredOutputs",
    label: "Structured Outputs",
    endpoint: "/structured-output",
    folder: "structuredOutputs",
  },
  {
    key: "personalities",
    label: "Personalities",
    endpoint: "/eval/simulation/personality",
    folder: "simulations/personalities",
  },
  {
    key: "scenarios",
    label: "Scenarios",
    endpoint: "/eval/simulation/scenario",
    folder: "simulations/scenarios",
  },
  {
    key: "simulations",
    label: "Simulations",
    endpoint: "/eval/simulation",
    folder: "simulations/tests",
  },
  {
    key: "simulationSuites",
    label: "Simulation Suites",
    endpoint: "/eval/simulation/suite",
    folder: "simulations/suites",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ANSI helpers
// ─────────────────────────────────────────────────────────────────────────────

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function isBack(result: string[]): boolean {
  return result.length === 1 && result[0] === BACK_SENTINEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Org Detection
// ─────────────────────────────────────────────────────────────────────────────

interface OrgInfo {
  slug: string;
  hasEnv: boolean;
  hasResources: boolean;
}

function detectOrgs(): OrgInfo[] {
  const slugs = new Map<string, OrgInfo>();

  // Scan .env.* files
  const baseEntries = readdirSync(BASE_DIR);
  for (const entry of baseEntries) {
    const match = entry.match(/^\.env\.(.+)$/);
    if (!match) continue;
    const slug = match[1]!;
    if (slug === "example" || slug === "local" || slug.endsWith(".local"))
      continue;
    if (!SLUG_RE.test(slug)) continue;
    if (!slugs.has(slug))
      slugs.set(slug, { slug, hasEnv: false, hasResources: false });
    slugs.get(slug)!.hasEnv = true;
  }

  // Scan resources/ directories
  const resourcesDir = join(BASE_DIR, "resources");
  if (existsSync(resourcesDir)) {
    for (const entry of readdirSync(resourcesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!SLUG_RE.test(entry.name)) continue;
      if (!slugs.has(entry.name))
        slugs.set(entry.name, {
          slug: entry.name,
          hasEnv: false,
          hasResources: false,
        });
      slugs.get(entry.name)!.hasResources = true;
    }
  }

  return [...slugs.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// ─────────────────────────────────────────────────────────────────────────────
// Env File Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadOrgEnv(slug: string): { token: string; baseUrl: string } {
  const envPath = join(BASE_DIR, `.env.${slug}`);
  if (!existsSync(envPath)) {
    throw new Error(
      `No .env.${slug} file found. Run "npm run setup" first to configure this org.`,
    );
  }

  const vars: Record<string, string> = {};
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[trimmed.slice(0, eq).trim()] = val;
  }

  const token = vars.VAPI_TOKEN;
  if (!token) {
    throw new Error(
      `.env.${slug} is missing VAPI_TOKEN. Run "npm run setup" to fix.`,
    );
  }

  return {
    token,
    baseUrl: vars.VAPI_BASE_URL || "https://api.vapi.ai",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Org Selection Prompt
// ─────────────────────────────────────────────────────────────────────────────

async function selectOrg(action: "pull" | "push"): Promise<string> {
  const orgs = detectOrgs();

  if (orgs.length === 0) {
    console.error(
      c.red(
        '\n  No configured orgs found. Run "npm run setup" to add one.\n',
      ),
    );
    process.exit(1);
  }

  if (orgs.length === 1) {
    const org = orgs[0]!;
    console.log(c.dim(`  Using org: ${org.slug}\n`));
    return org.slug;
  }

  const slug = await select({
    message: `Select org to ${action}`,
    choices: orgs.map((org) => {
      const tags: string[] = [];
      if (org.hasEnv) tags.push("env");
      if (org.hasResources) tags.push("resources");
      return {
        name: `${org.slug} ${c.dim(`(${tags.join(", ")})`)}`,
        value: org.slug,
      };
    }),
  });

  return slug;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Client
// ─────────────────────────────────────────────────────────────────────────────

async function apiGet(
  token: string,
  baseUrl: string,
  endpoint: string,
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
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

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

function resourceDisplayName(r: Record<string, unknown>): string {
  if (typeof r.name === "string" && r.name) return r.name;
  const fn = r.function as Record<string, unknown> | undefined;
  const fnName = typeof fn?.name === "string" ? fn.name : "";
  const rType = typeof r.type === "string" ? r.type : "";
  if (fnName && rType) return `${fnName} (${rType})`;
  if (fnName) return fnName;
  if (rType) return `${rType} (${(r.id as string).slice(0, 8)}…)`;
  return r.id as string;
}

function quickExtractName(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".md")) {
      const match = content.match(/^---\r?\n[\s\S]*?^name:\s*(.+)/m);
      return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? null;
    }
    const match = content.match(/^name:\s*(.+)/m);
    if (match?.[1]) {
      let val = match[1].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      )
        val = val.slice(1, -1);
      return val;
    }
    // For tools: function.name
    const fnMatch = content.match(
      /^function:\s*\n\s+name:\s*(.+)/m,
    );
    if (fnMatch?.[1]) {
      return fnMatch[1].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    /* ignore parse errors */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Resource Scanning
// ─────────────────────────────────────────────────────────────────────────────

interface LocalResource {
  typeKey: string;
  typeLabel: string;
  resourceId: string;
  filePath: string;
  displayName: string;
}

function scanLocalResources(slug: string): LocalResource[] {
  const resourcesDir = join(BASE_DIR, "resources", slug);
  if (!existsSync(resourcesDir)) return [];

  const resources: LocalResource[] = [];

  for (const typeDef of RESOURCE_TYPES) {
    const typeDir = join(resourcesDir, typeDef.folder);
    if (!existsSync(typeDir)) continue;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        const ext = extname(entry.name);
        if (![".yml", ".yaml", ".md", ".ts"].includes(ext)) continue;

        const relPath = relative(typeDir, fullPath);
        const resourceId = relPath.slice(0, -ext.length);
        const name = quickExtractName(fullPath);
        const displayName = name || resourceId;

        resources.push({
          typeKey: typeDef.key,
          typeLabel: typeDef.label,
          resourceId,
          filePath: fullPath,
          displayName,
        });
      }
    };

    walk(typeDir);
  }

  return resources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Git Status Detection
// ─────────────────────────────────────────────────────────────────────────────

type GitStatusCode = "M" | "A" | "D" | "?" | "";

function getGitFileStatuses(slug: string): Map<string, GitStatusCode> {
  const statuses = new Map<string, GitStatusCode>();
  try {
    const output = execSync("git status --porcelain", {
      cwd: BASE_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!output) return statuses;

    const prefix = `resources/${slug}/`;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const xy = line.slice(0, 2);
      let filePath = line.slice(3);
      const arrowIdx = filePath.indexOf(" -> ");
      if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4);
      filePath = filePath.replace(/^"|"$/g, "").trim();

      if (!filePath.startsWith(prefix)) continue;

      let code: GitStatusCode = "";
      if (xy.includes("M")) code = "M";
      else if (xy.includes("A") || xy === "??") code = "A";
      else if (xy.includes("D")) code = "D";

      if (code) {
        const absPath = join(BASE_DIR, filePath);
        statuses.set(absPath, code);
      }
    }
  } catch {
    /* not a git repo or git not available */
  }
  return statuses;
}

function gitStatusLabel(code: GitStatusCode): string {
  switch (code) {
    case "M":
      return c.yellow("[modified]");
    case "A":
      return c.green("[new]");
    case "D":
      return c.red("[deleted]");
    default:
      return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State File — detect which remote resources are already pulled locally
// ─────────────────────────────────────────────────────────────────────────────

function loadKnownUuids(slug: string): Set<string> {
  const statePath = join(BASE_DIR, `.vapi-state.${slug}.json`);
  if (!existsSync(statePath)) return new Set();
  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw) as Record<string, Record<string, string>>;
    const uuids = new Set<string>();
    for (const section of Object.values(state)) {
      if (typeof section !== "object" || section === null) continue;
      for (const uuid of Object.values(section)) {
        if (typeof uuid === "string") uuids.add(uuid);
      }
    }
    return uuids;
  } catch {
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess helpers
// ─────────────────────────────────────────────────────────────────────────────

function spawnScript(args: string[]): void {
  const binDir = join(BASE_DIR, "node_modules", ".bin");
  const pathSep = process.platform === "win32" ? ";" : ":";
  execSync(["tsx", ...args].join(" "), {
    cwd: BASE_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${binDir}${pathSep}${process.env.PATH ?? ""}`,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Pull
// ─────────────────────────────────────────────────────────────────────────────

interface ResourceSnapshot {
  key: string;
  label: string;
  resources: Record<string, unknown>[];
}

export async function runInteractivePull(): Promise<void> {
  console.log("");
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log(c.bold("  Vapi GitOps — Interactive Pull"));
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log("");

  type Step = "org" | "scope" | "pick" | "confirm" | "execute";
  let step: Step = "org";

  let slug = "";
  let token = "";
  let baseUrl = "";
  let snapshots: ResourceSnapshot[] = [];
  let nonEmpty: ResourceSnapshot[] = [];
  let totalCount = 0;
  let picked: string[] = [];

  while (step !== "execute") {
    switch (step) {
      // ── Org selection ───────────────────────────────────────────────
      case "org": {
        slug = await selectOrg("pull");
        ({ token, baseUrl } = loadOrgEnv(slug));

        console.log(c.dim("  Fetching remote resources...\n"));

        snapshots = await Promise.all(
          RESOURCE_TYPES.map(
            async (type): Promise<ResourceSnapshot> => {
              try {
                const data = await apiGet(token, baseUrl, type.endpoint);
                return {
                  key: type.key,
                  label: type.label,
                  resources: normaliseList(data),
                };
              } catch {
                return { key: type.key, label: type.label, resources: [] };
              }
            },
          ),
        );

        nonEmpty = snapshots.filter((s) => s.resources.length > 0);
        totalCount = nonEmpty.reduce(
          (n, s) => n + s.resources.length,
          0,
        );

        if (nonEmpty.length === 0) {
          console.log(c.yellow("  No remote resources found.\n"));
          return;
        }

        step = "scope";
        break;
      }

      // ── All / Pick scope ────────────────────────────────────────────
      case "scope": {
        const scope = await select({
          message: "Which resources to pull?",
          choices: [
            {
              name: `All (${totalCount} resources across ${nonEmpty.length} types)`,
              value: "all" as const,
            },
            { name: "Let me pick…", value: "pick" as const },
            { name: c.dim("← Back"), value: "back" as const },
          ],
        });

        if (scope === "back") {
          step = "org";
          break;
        }

        if (scope === "all") {
          console.log(c.dim("\n  Pulling all resources...\n"));
          spawnScript(["src/pull.ts", slug, "--force"]);
          console.log(c.green("\n  Done!\n"));
          return;
        }

        step = "pick";
        break;
      }

      // ── Individual resource picker ──────────────────────────────────
      case "pick": {
        const knownUuids = loadKnownUuids(slug);
        const localCount = nonEmpty.reduce(
          (n, s) =>
            n +
            s.resources.filter((r) => knownUuids.has(r.id as string))
              .length,
          0,
        );
        if (localCount > 0) {
          console.log(
            c.dim(
              `  ${localCount}/${totalCount} already pulled locally (marked ✔)\n`,
            ),
          );
        }

        const allChoices = nonEmpty.flatMap((snap) =>
          snap.resources.map((r) => {
            const isLocal = knownUuids.has(r.id as string);
            const tag = isLocal ? c.dim(" ✔ local") : "";
            return {
              value: `${snap.key}::${r.id as string}`,
              name: `${resourceDisplayName(r)}${tag}`,
              group: snap.label,
              checked: false,
            };
          }),
        );

        picked = await searchableCheckbox({
          message: "Select resources to pull",
          choices: allChoices,
          pageSize: 20,
        });

        if (isBack(picked)) {
          step = "scope";
          break;
        }

        if (picked.length === 0) {
          console.log(c.dim("\n  Nothing selected.\n"));
          return;
        }

        step = "confirm";
        break;
      }

      // ── Confirm ─────────────────────────────────────────────────────
      case "confirm": {
        const selectedIds = new Set(picked);

        console.log("\n  Pull list:");
        for (const snap of snapshots) {
          const count = [...selectedIds].filter((v) =>
            v.startsWith(`${snap.key}::`),
          ).length;
          if (count > 0) {
            console.log(
              `    ${c.green("✓")} ${snap.label} (${count}/${snap.resources.length})`,
            );
          }
        }
        console.log("");

        const action = await select({
          message: `Pull ${picked.length} resource(s)?`,
          choices: [
            { name: "Yes, pull", value: "yes" as const },
            { name: "No, cancel", value: "no" as const },
            { name: c.dim("← Back to selection"), value: "back" as const },
          ],
        });

        if (action === "back") {
          step = "pick";
          break;
        }
        if (action === "no") {
          console.log(c.dim("\n  Cancelled.\n"));
          return;
        }

        step = "execute";
        break;
      }
    }
  }

  // ── Execute pull ──────────────────────────────────────────────────────
  const byType = new Map<string, string[]>();
  for (const id of picked) {
    const sep = id.indexOf("::");
    const typeKey = id.substring(0, sep);
    const uuid = id.substring(sep + 2);
    if (!byType.has(typeKey)) byType.set(typeKey, []);
    byType.get(typeKey)!.push(uuid);
  }

  console.log(c.dim("\n  Pulling...\n"));

  for (const [typeKey, uuids] of byType) {
    const idArgs = uuids.flatMap((id) => ["--id", id]);
    spawnScript([
      "src/pull.ts",
      slug,
      "--force",
      "--type",
      typeKey,
      ...idArgs,
    ]);
  }

  console.log(c.green("\n  Done!\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Push
// ─────────────────────────────────────────────────────────────────────────────

export async function runInteractivePush(): Promise<void> {
  console.log("");
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log(c.bold("  Vapi GitOps — Interactive Push"));
  console.log(
    c.bold(
      "═══════════════════════════════════════════════════════════════",
    ),
  );
  console.log("");

  type Step = "org" | "scope" | "pick" | "confirm" | "execute";
  let step: Step = "org";

  let slug = "";
  let resources: LocalResource[] = [];
  let gitStatuses = new Map<string, GitStatusCode>();
  let picked: string[] = [];

  while (step !== "execute") {
    switch (step) {
      // ── Org selection ───────────────────────────────────────────────
      case "org": {
        slug = await selectOrg("push");
        resources = scanLocalResources(slug);

        if (resources.length === 0) {
          console.log(
            c.yellow(`  No local resources found in resources/${slug}/.\n`),
          );
          return;
        }

        gitStatuses = getGitFileStatuses(slug);
        const modifiedCount = [...gitStatuses.values()].filter(
          (s) => s === "M",
        ).length;
        const newCount = [...gitStatuses.values()].filter(
          (s) => s === "A",
        ).length;

        if (modifiedCount > 0 || newCount > 0) {
          const parts: string[] = [];
          if (modifiedCount > 0) parts.push(`${modifiedCount} modified`);
          if (newCount > 0) parts.push(`${newCount} new`);
          console.log(c.dim(`  Git status: ${parts.join(", ")}\n`));
        }

        step = "scope";
        break;
      }

      // ── All / Pick scope ────────────────────────────────────────────
      case "scope": {
        const scope = await select({
          message: "Which resources to push?",
          choices: [
            {
              name: `All (${resources.length} resources)`,
              value: "all" as const,
            },
            { name: "Let me pick…", value: "pick" as const },
            { name: c.dim("← Back"), value: "back" as const },
          ],
        });

        if (scope === "back") {
          step = "org";
          break;
        }

        if (scope === "all") {
          console.log(c.dim("\n  Pushing all resources...\n"));
          spawnScript(["src/push.ts", slug]);
          console.log(c.green("\n  Done!\n"));
          return;
        }

        step = "pick";
        break;
      }

      // ── Individual resource picker ──────────────────────────────────
      case "pick": {
        const allChoices = resources.map((r) => {
          const status = gitStatuses.get(r.filePath);
          const statusTag = status ? ` ${gitStatusLabel(status)}` : "";
          return {
            value: r.filePath,
            name: `${r.displayName}${statusTag}`,
            group: r.typeLabel,
            checked: false,
          };
        });

        allChoices.sort((a, b) => {
          if (a.group !== b.group) return 0;
          const aStatus = gitStatuses.get(a.value) || "";
          const bStatus = gitStatuses.get(b.value) || "";
          if (aStatus && !bStatus) return -1;
          if (!aStatus && bStatus) return 1;
          return 0;
        });

        picked = await searchableCheckbox({
          message: "Select resources to push",
          choices: allChoices,
          pageSize: 20,
        });

        if (isBack(picked)) {
          step = "scope";
          break;
        }

        if (picked.length === 0) {
          console.log(c.dim("\n  Nothing selected.\n"));
          return;
        }

        step = "confirm";
        break;
      }

      // ── Confirm ─────────────────────────────────────────────────────
      case "confirm": {
        const selectedSet = new Set(picked);
        const byGroup = new Map<string, number>();
        for (const r of resources) {
          if (!selectedSet.has(r.filePath)) continue;
          byGroup.set(r.typeLabel, (byGroup.get(r.typeLabel) ?? 0) + 1);
        }

        console.log("\n  Push list:");
        for (const [group, count] of byGroup) {
          console.log(`    ${c.green("✓")} ${group} (${count})`);
        }
        console.log("");

        const action = await select({
          message: `Push ${picked.length} resource(s)?`,
          choices: [
            { name: "Yes, push", value: "yes" as const },
            { name: "No, cancel", value: "no" as const },
            { name: c.dim("← Back to selection"), value: "back" as const },
          ],
        });

        if (action === "back") {
          step = "pick";
          break;
        }
        if (action === "no") {
          console.log(c.dim("\n  Cancelled.\n"));
          return;
        }

        step = "execute";
        break;
      }
    }
  }

  // ── Execute push ──────────────────────────────────────────────────────
  const relPaths = picked.map((p) => relative(BASE_DIR, p));
  console.log(c.dim("\n  Pushing...\n"));
  spawnScript(["src/push.ts", slug, ...relPaths]);
  console.log(c.green("\n  Done!\n"));
}
