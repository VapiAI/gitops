import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_MAX_GITOPS_RPM = 100;

function positive(value: unknown, source: string): number {
  const number =
    typeof value === "number" ? value :
    typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number <= 0)
    throw new Error(`❌ Invalid max GitOps RPM in ${source}: expected a positive integer (a GitOps client limit, not a Vapi org limit).`);
  return number;
}

export function maxGitopsRpmRead(rootDir: string, org: string, env: NodeJS.ProcessEnv = process.env): number {
  const pin = join(rootDir, "resources", org, ".vapi-org.json");
  let value = DEFAULT_MAX_GITOPS_RPM;
  if (existsSync(pin)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(pin, "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Can't read resources/${org}/.vapi-org.json: ${reason}. Restore it from git.`);
    }
    if (parsed && Object.hasOwn(parsed, "maxGitopsRpm")) value = positive(parsed.maxGitopsRpm, `resources/${org}/.vapi-org.json maxGitopsRpm`);
  }
  let fileValue: number | undefined;
  for (const name of [`.env.${org}`, `.env.${org}.local`, ".env.local"]) {
    const path = join(rootDir, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*VAPI_MAX_GITOPS_RPM\s*=\s*(.*?)\s*$/.exec(line);
      if (match) {
        const number = positive(match[1]!.replace(/^(["'])(.*)\1$/, "$2"), `${name} VAPI_MAX_GITOPS_RPM`);
        fileValue ??= number;
      }
    }
  }
  return env.VAPI_MAX_GITOPS_RPM === undefined ? fileValue ?? value : positive(env.VAPI_MAX_GITOPS_RPM, "environment VAPI_MAX_GITOPS_RPM");
}

export class TokenBucket {
  private tokens: number;
  readonly capacity: number;
  private updated: number;
  private queue = Promise.resolve();
  constructor(readonly rpm: number, private now = () => performance.now(), private sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
    positive(rpm, "token bucket");
    this.capacity = Math.max(1, Math.ceil(rpm / 60));
    this.tokens = this.capacity;
    this.updated = now();
  }
  acquire(): Promise<void> {
    const next = this.queue.then(async () => {
      for (;;) {
        const now = this.now();
        this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updated) * this.rpm / 60_000);
        this.updated = now;
        if (this.tokens + 1e-9 >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep((1 - this.tokens) * 60_000 / this.rpm);
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

const buckets = new Map<string, TokenBucket>();
export function orgLimiter(rootDir: string, org: string, rpm = maxGitopsRpmRead(rootDir, org)): TokenBucket {
  const key = `${resolve(rootDir)}\0${org}`;
  let limiter = buckets.get(key);
  if (!limiter) {
    limiter = new TokenBucket(rpm);
    buckets.set(key, limiter);
  }
  return limiter;
}
