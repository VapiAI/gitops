import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

// Keep shell overrides separate from values merged into process.env later.
export const shellEnvironment = { ...process.env };

export function orgEnvFilesRead(rootDir: string, org: string) {
  return [`.env.${org}`, `.env.${org}.local`, ".env.local"]
    .filter((name) => existsSync(join(rootDir, name)))
    .map((name) => ({
      name,
      values: parseEnv(readFileSync(join(rootDir, name), "utf8")),
    }));
}
