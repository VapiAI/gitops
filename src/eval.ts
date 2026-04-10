import { existsSync, readFileSync, statSync } from "fs";
import { join, dirname, basename, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { readFile } from "fs/promises";
import type { Environment, StateFile } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

function resourcesDir(env: string): string {
  return join(BASE_DIR, "resources", env);
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180_000;

// ─────────────────────────────────────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────────────────────────────────────

interface EvalConfig {
  env: Environment;
  token: string;
  baseUrl: string;
  variablesFile?: string;
  squadName?: string;
  assistantName?: string;
  evalFilter?: string;
}

function printUsage(): void {
  console.error("Usage: tsx src/eval.ts <env> -s <squad-name> [options]");
  console.error("       tsx src/eval.ts <env> -a <assistant-name> [options]");
  console.error("");
  console.error("Runs Vapi Evals (mock conversation tests) against a transient or stored assistant/squad.");
  console.error("Evals must be pushed first (npm run push:dev evals). Assistants/squads can be transient.");
  console.error("");
  console.error("Options:");
  console.error("  -s <name>         Target squad (by resource filename, loaded as transient)");
  console.error("  -a <name|path>    Assistant: resource id, or path to .md/.yml (cwd or repo root)");
  console.error("  -v <file>         Variable values JSON file (default: eval-variables.json)");
  console.error("  --filter <name>   Run only evals matching this substring");
  console.error("  --stored          Use stored assistantId/squadId from state instead of transient");
  console.error("");
  console.error("Examples:");
  console.error("  tsx src/eval.ts dev -s everblue-voice-squad-20374c37");
  console.error("  tsx src/eval.ts dev -a everblue-main-agent-633ab678 --filter name-collection");
  console.error("  tsx src/eval.ts dev -a resources/assistants/qa-address-resolution-tester-e9ed5d49.md");
  console.error("  tsx src/eval.ts dev -s everblue-voice-squad-20374c37 --stored");
}

function parseArgs(): EvalConfig & { useStored: boolean } {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    printUsage();
    process.exit(1);
  }

  const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  const env = args[0] as Environment;
  if (!env || !SLUG_RE.test(env)) {
    console.error(`❌ Invalid org name: ${env}`);
    console.error(
      "   Must be lowercase alphanumeric with optional hyphens (e.g., dev, my-org)",
    );
    process.exit(1);
  }

  let squadName: string | undefined;
  let assistantName: string | undefined;
  let variablesFile: string | undefined;
  let evalFilter: string | undefined;
  let useStored = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" || arg === "--squad") { squadName = args[++i]; }
    else if (arg === "-a" || arg === "--assistant") { assistantName = args[++i]; }
    else if (arg === "-v" || arg === "--variables") { variablesFile = args[++i]; }
    else if (arg === "--filter") { evalFilter = args[++i]; }
    else if (arg === "--stored") { useStored = true; }
  }

  if (!squadName && !assistantName) {
    console.error("❌ Must specify -s <squad> or -a <assistant>");
    printUsage();
    process.exit(1);
  }

  const { token, baseUrl } = loadEnvFile(env);
  return { env, token, baseUrl, variablesFile, squadName, assistantName, evalFilter, useStored };
}

function loadEnvFile(env: string): { token: string; baseUrl: string } {
  const envFiles = [
    join(BASE_DIR, `.env.${env}`),
    join(BASE_DIR, `.env.${env}.local`),
    join(BASE_DIR, ".env.local"),
  ];
  const envVars: Record<string, string> = {};
  for (const envFile of envFiles) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (envVars[key] === undefined) envVars[key] = value;
    }
  }
  const token = process.env.VAPI_TOKEN || envVars.VAPI_TOKEN;
  const baseUrl = process.env.VAPI_BASE_URL || envVars.VAPI_BASE_URL || "https://api.vapi.ai";
  if (!token) {
    console.error(`❌ VAPI_TOKEN not found. Create .env.${env} with VAPI_TOKEN=your-token`);
    process.exit(1);
  }
  return { token, baseUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// State & Resource Loading
// ─────────────────────────────────────────────────────────────────────────────

function loadState(env: Environment): StateFile {
  const stateFile = join(BASE_DIR, `.vapi-state.${env}.json`);
  if (!existsSync(stateFile)) {
    console.error(`❌ State file not found: .vapi-state.${env}.json`);
    console.error("   Run 'npm run push:dev evals' first to create eval resources");
    process.exit(1);
  }
  const content = readFileSync(stateFile, "utf-8");
  const state = JSON.parse(content) as StateFile;
  if (!state.evals) state.evals = {};
  return state;
}

function parseFrontmatter(content: string): { config: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match || !match[1]) throw new Error("Invalid frontmatter format");
  return { config: parseYaml(match[1]) as Record<string, unknown>, body: (match[2] ?? "").trim() };
}

function assistantModelInjectMarkdownSystem(config: Record<string, unknown>, body: string): void {
  if (!body) return;
  const model = (config.model as Record<string, unknown>) || {};
  const existing = Array.isArray(model.messages) ? model.messages : [];
  model.messages = [{ role: "system", content: body }, ...existing.filter((m: { role?: string }) => m.role !== "system")];
  config.model = model;
}

async function loadAssistantFromFilePath(filePath: string): Promise<Record<string, unknown>> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".md")) {
    const { config, body } = parseFrontmatter(await readFile(filePath, "utf-8"));
    assistantModelInjectMarkdownSystem(config, body);
    return config;
  }
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return parseYaml(await readFile(filePath, "utf-8")) as Record<string, unknown>;
  }
  throw new Error(`Unsupported assistant file (use .md, .yml, .yaml): ${filePath}`);
}

/** True when -a value should be tried as a filesystem path before resources/assistants/<name>. */
function assistantArgLooksLikeFilePath(arg: string): boolean {
  if (isAbsolute(arg)) return true;
  if (arg.startsWith("./") || arg.startsWith("../")) return true;
  if (arg.includes("/") || arg.includes("\\")) return true;
  const lower = arg.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".yml") || lower.endsWith(".yaml");
}

/** Resolves a path-like -a argument to an existing file, or undefined to use resource-name flow. */
function assistantArgResolveExistingFile(arg: string): string | undefined {
  if (!assistantArgLooksLikeFilePath(arg)) return undefined;
  const candidates: string[] = [];
  if (isAbsolute(arg)) {
    candidates.push(arg);
  } else {
    candidates.push(join(BASE_DIR, arg));
    candidates.push(join(process.cwd(), arg));
  }
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* broken symlink etc. */
    }
  }
  return undefined;
}

async function loadAssistant(name: string, env: string): Promise<Record<string, unknown>> {
  const dir = resourcesDir(env);
  const mdPath = join(dir, "assistants", `${name}.md`);
  if (existsSync(mdPath)) return loadAssistantFromFilePath(mdPath);
  const ymlPath = join(dir, "assistants", `${name}.yml`);
  if (existsSync(ymlPath)) return loadAssistantFromFilePath(ymlPath);
  throw new Error(`Assistant not found: ${name}`);
}

async function loadAssistantForEvalTarget(arg: string, env: string): Promise<{ config: Record<string, unknown>; sourcePath?: string }> {
  const resolved = assistantArgResolveExistingFile(arg);
  if (resolved) {
    return { config: await loadAssistantFromFilePath(resolved), sourcePath: resolved };
  }
  if (assistantArgLooksLikeFilePath(arg)) {
    throw new Error(
      `Assistant file not found: ${arg} (tried ${join(BASE_DIR, arg)} and ${join(process.cwd(), arg)})`,
    );
  }
  return { config: await loadAssistant(arg, env) };
}

async function loadSquad(name: string, env: string): Promise<Record<string, unknown>> {
  const filePath = join(resourcesDir(env), "squads", `${name}.yml`);
  if (!existsSync(filePath)) throw new Error(`Squad not found: ${filePath}`);
  return parseYaml(await readFile(filePath, "utf-8")) as Record<string, unknown>;
}

function loadVariables(config: EvalConfig): Record<string, unknown> | undefined {
  const candidates = [config.variablesFile, "eval-variables.json", "resources/eval-variables.json"].filter(Boolean) as string[];
  for (const f of candidates) {
    const resolved = f.startsWith("/") ? f : join(BASE_DIR, f);
    if (existsSync(resolved)) {
      console.log(`📋 Loading variables: ${basename(resolved)}`);
      const raw = JSON.parse(readFileSync(resolved, "utf-8"));
      return raw.squadOverrides?.variableValues ?? raw.assistantOverrides?.variableValues ?? raw.variableValues ?? raw;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference Resolution
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveId(id: string, stateSection: Record<string, string>): string {
  const clean = id.split("##")[0]?.trim() ?? "";
  if (UUID_RE.test(clean)) return clean;
  return stateSection[clean] ?? clean;
}

function resolveAssistantConfig(config: Record<string, unknown>, state: StateFile): Record<string, unknown> {
  const resolved = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const model = resolved.model as Record<string, unknown> | undefined;
  if (model && Array.isArray(model.toolIds)) {
    model.toolIds = (model.toolIds as string[]).map(id => resolveId(id, state.tools));
  }
  const ap = resolved.artifactPlan as Record<string, unknown> | undefined;
  if (ap && Array.isArray(ap.structuredOutputIds)) {
    ap.structuredOutputIds = (ap.structuredOutputIds as string[]).map(id => resolveId(id, state.structuredOutputs));
  }
  if (Array.isArray(resolved.hooks)) {
    for (const hook of resolved.hooks as Record<string, unknown>[]) {
      if (Array.isArray(hook.do)) {
        for (const action of hook.do as Record<string, unknown>[]) {
          if (typeof action.toolId === "string" && !UUID_RE.test(action.toolId)) {
            action.toolId = resolveId(action.toolId, state.tools);
          }
        }
      }
    }
  }
  // Resolve credentials
  const credMap = new Map(Object.entries(state.credentials));
  if (credMap.size > 0) return deepReplace(resolved, credMap) as Record<string, unknown>;
  return resolved;
}

async function resolveSquadConfig(config: Record<string, unknown>, state: StateFile, expandTransient: boolean, env: string): Promise<Record<string, unknown>> {
  const resolved = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  if (Array.isArray(resolved.members)) {
    for (const member of resolved.members as Record<string, unknown>[]) {
      if (typeof member.assistantId === "string") {
        const localId = member.assistantId.split("##")[0]?.trim() ?? "";
        if (expandTransient && !UUID_RE.test(localId)) {
          try {
            const assistantConfig = await loadAssistant(localId, env);
            delete member.assistantId;
            member.assistant = resolveAssistantConfig(assistantConfig, state);
          } catch { member.assistantId = resolveId(localId, state.assistants); }
        } else {
          member.assistantId = resolveId(localId, state.assistants);
        }
      }
      const overrides = member.assistantOverrides as Record<string, unknown> | undefined;
      const toolsAppend = overrides?.["tools:append"] as Record<string, unknown>[] | undefined;
      if (Array.isArray(toolsAppend)) {
        for (const tool of toolsAppend) {
          if (Array.isArray(tool.destinations)) {
            for (const dest of tool.destinations as Record<string, unknown>[]) {
              if (typeof dest.assistantId === "string" && !UUID_RE.test(dest.assistantId)) {
                dest.assistantId = resolveId(dest.assistantId, state.assistants);
              }
            }
          }
        }
      }
    }
  }
  const credMap = new Map(Object.entries(state.credentials));
  if (credMap.size > 0) return deepReplace(resolved, credMap) as Record<string, unknown>;
  return resolved;
}

function deepReplace(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map(v => deepReplace(v, map));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) result[k] = deepReplace(v, map);
    return result;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eval Loading — reads resources/evals/*.yml and resolves to platform UUIDs
// ─────────────────────────────────────────────────────────────────────────────

interface EvalDefinition {
  resourceId: string;
  evalId: string; // platform UUID from state
  name: string;
}

function loadEvals(state: StateFile, filter?: string): EvalDefinition[] {
  const evalState = state.evals ?? {};
  const evals: EvalDefinition[] = [];

  for (const [resourceId, uuid] of Object.entries(evalState)) {
    if (filter && !resourceId.toLowerCase().includes(filter.toLowerCase())) continue;
    evals.push({ resourceId, evalId: uuid, name: resourceId });
  }

  return evals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vapi API
// ─────────────────────────────────────────────────────────────────────────────

interface EvalRunResult {
  id?: string;
  evalRunId?: string;
  status?: string;
  endedReason?: string;
  endedMessage?: string;
  results?: Array<{
    status?: string;
    failureReason?: string;
    [key: string]: unknown;
  }>;
  cost?: number;
  error?: string;
  [key: string]: unknown;
}

async function apiRequest(config: EvalConfig, method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const url = `${config.baseUrl}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${method} ${endpoint} → ${response.status}: ${text}`);
  }
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function createEvalRun(config: EvalConfig, evalId: string, target: Record<string, unknown>): Promise<string> {
  const body = {
    type: "eval",
    evalId,
    target,
  };
  const result = await apiRequest(config, "POST", "/eval/run", body) as EvalRunResult;
  const runId = result.evalRunId ?? result.id;
  if (typeof result.error === "string" && result.error) {
    throw new Error(result.error);
  }
  if (!runId) {
    throw new Error(
      `POST /eval/run returned no evalRunId (keys: ${Object.keys(result).join(", ")})`,
    );
  }
  return runId;
}

async function pollEvalRun(config: EvalConfig, runId: string): Promise<EvalRunResult> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const result = await apiRequest(config, "GET", `/eval/run/${runId}`) as EvalRunResult;
    if (result.status === "ended") return result;
    process.stdout.write(".");
  }
  throw new Error(`Eval run ${runId} timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();
  const state = loadState(config.env);
  const variableValues = loadVariables(config);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`🧪 Vapi GitOps Eval Runner — Environment: ${config.env}`);
  console.log(`   API: ${config.baseUrl}`);
  if (config.squadName) console.log(`   Squad: ${config.squadName}${config.useStored ? " (stored)" : " (transient)"}`);
  if (config.assistantName) console.log(`   Assistant: ${config.assistantName}${config.useStored ? " (stored)" : " (transient)"}`);
  if (variableValues) console.log(`   Variables: ${Object.keys(variableValues).length} keys`);
  if (config.evalFilter) console.log(`   Filter: "${config.evalFilter}"`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Build the target (transient or stored)
  let target: Record<string, unknown>;

  if (config.squadName) {
    if (config.useStored) {
      const squadId = state.squads[config.squadName];
      if (!squadId) {
        console.error(`❌ Squad not found in state: ${config.squadName}`);
        console.error("   Available: " + Object.keys(state.squads).join(", "));
        process.exit(1);
      }
      target = {
        type: "squad",
        squadId,
        ...(variableValues ? { assistantOverrides: { variableValues } } : {}),
      };
    } else {
      console.log("📂 Loading squad as transient config...\n");
      const squadConfig = await loadSquad(config.squadName, config.env);
      const resolved = await resolveSquadConfig(squadConfig, state, true, config.env);
      target = {
        type: "squad",
        squad: resolved,
        ...(variableValues ? { assistantOverrides: { variableValues } } : {}),
      };
    }
  } else {
    if (config.useStored) {
      const assistantId = state.assistants[config.assistantName!];
      if (!assistantId) {
        console.error(`❌ Assistant not found in state: ${config.assistantName}`);
        process.exit(1);
      }
      target = {
        type: "assistant",
        assistantId,
        ...(variableValues ? { assistantOverrides: { variableValues } } : {}),
      };
    } else {
      const { config: assistantConfig, sourcePath } = await loadAssistantForEvalTarget(config.assistantName!, config.env);
      console.log(
        sourcePath
          ? `📂 Loading assistant from file: ${sourcePath}\n`
          : "📂 Loading assistant as transient config...\n",
      );
      const resolved = resolveAssistantConfig(assistantConfig, state);
      target = {
        type: "assistant",
        assistant: resolved,
        ...(variableValues ? { assistantOverrides: { variableValues } } : {}),
      };
    }
  }

  // Load eval definitions from state (they must be pushed first)
  const evals = loadEvals(state, config.evalFilter);
  if (evals.length === 0) {
    console.error("❌ No evals found in state" + (config.evalFilter ? ` matching "${config.evalFilter}"` : ""));
    console.error("   Push evals first: npm run push:dev evals");
    console.error("   Eval files go in: resources/evals/");
    process.exit(1);
  }

  console.log(`📋 Running ${evals.length} eval(s)...\n`);

  // Run each eval
  const results: Array<{ eval: string; runId: string; passed: boolean; failureReason?: string; cost?: number }> = [];

  for (const evalDef of evals) {
    process.stdout.write(`  🧪 ${evalDef.name} `);
    try {
      const runId = await createEvalRun(config, evalDef.evalId, target);
      process.stdout.write(`[${runId}] `);

      const result = await pollEvalRun(config, runId);
      const allPassed = (result.results ?? []).every(r => r.status === "pass");
      const passed = result.endedReason === "mockConversation.done" && allPassed;

      results.push({
        eval: evalDef.name,
        runId,
        passed,
        failureReason: !passed ? (result.endedMessage ?? result.endedReason) : undefined,
        cost: result.cost as number | undefined,
      });

      if (passed) {
        console.log(" ✅ PASS");
      } else {
        console.log(" ❌ FAIL");
        if (result.endedMessage) console.log(`     Reason: ${result.endedMessage}`);
        for (const r of result.results ?? []) {
          if (r.status === "fail") {
            console.log(`     → ${r.failureReason || JSON.stringify(r)}`);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(` ❌ ERROR: ${msg}`);
      results.push({ eval: evalDef.name, runId: "n/a", passed: false, failureReason: msg });
    }
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const totalCost = results.reduce((sum, r) => sum + (r.cost ?? 0), 0);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`📊 Results: ${passed}/${results.length} passed, ${failed} failed`);
  if (totalCost > 0) console.log(`💰 Total cost: $${totalCost.toFixed(4)}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.log("❌ Failed evals:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`   - ${r.eval}: ${r.failureReason || "unknown"}`);
    }
    console.log("\n💡 Fix the issues before pushing assistant/squad changes.");
    process.exit(1);
  }

  console.log("✅ All evals passed! Safe to push assistant/squad changes.");
}

main().catch((error) => {
  console.error("\n❌ Eval failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
