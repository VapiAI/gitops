// Argument parsing for `npm run setup`. Kept separate from setup.ts (which
// runs the wizard on import) so the parsing rules can be unit-tested.
//
//   npm run setup                                  → interactive wizard (TTY only)
//   npm run setup -- <org> [--region us|eu]
//                          [--resources all|none]  → non-interactive (agents / CI)
//
// The API key is deliberately NOT accepted as an argument: argv ends up in
// shell history, process listings, and agent transcripts. It comes from the
// VAPI_TOKEN environment variable or an existing `.env.<org>` file instead.

export type SetupRegion = "us" | "eu";
export type SetupResources = "all" | "none";

export interface DirectSetupOptions {
  slug: string;
  /** Explicit region; undefined means "use VAPI_BASE_URL or auto-detect". */
  region?: SetupRegion;
  resources: SetupResources;
}

export type SetupArgs =
  | { mode: "interactive" }
  | { mode: "help" }
  | { mode: "direct"; options: DirectSetupOptions }
  | { mode: "error"; message: string };

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const SECRET_FLAG_RE = /^--(token|api-key|apikey|key|vapi-token)(=|$)/i;

export const SETUP_USAGE = `Usage:
  npm run setup                                   Interactive wizard (needs a terminal)
  npm run setup -- <org> [options]                Non-interactive setup (agents / CI)

Options (non-interactive):
  --region us|eu           Vapi region. Default: VAPI_BASE_URL if set, else
                           auto-detect (tries US, then EU).
  --resources all|none     all  = download every resource into resources/<org>/ (default)
                           none = seed .vapi-state.<org>.json only, no resource files
  -h, --help               Show this help

The API key is read from the VAPI_TOKEN environment variable, or from an
existing .env.<org> file. It is never accepted as a command-line argument.

Examples:
  VAPI_TOKEN=... npm run setup -- my-org
  npm run setup -- my-org --resources none        (with .env.my-org already created)`;

/** Parse the arguments that follow `npm run setup --`. */
export function parseSetupArgs(argv: string[]): SetupArgs {
  if (argv.length === 0) return { mode: "interactive" };
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };

  let slug: string | undefined;
  let region: SetupRegion | undefined;
  let resources: SetupResources = "all";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (SECRET_FLAG_RE.test(arg)) {
      return {
        mode: "error",
        message:
          "Refusing to read an API key from the command line (it would leak into shell history and logs). " +
          "Set VAPI_TOKEN in the environment or put it in .env.<org> instead.",
      };
    }

    const [flag, inlineValue] = arg.startsWith("--")
      ? (arg.split(/=(.*)/s, 2) as [string, string | undefined])
      : [arg, undefined];

    if (flag === "--region" || flag === "--resources") {
      const value = inlineValue ?? argv[++i];
      if (value === undefined || value.startsWith("-")) {
        return { mode: "error", message: `${flag} requires a value` };
      }
      if (flag === "--region") {
        if (value !== "us" && value !== "eu") {
          return {
            mode: "error",
            message: `Invalid --region "${value}" (expected "us" or "eu")`,
          };
        }
        region = value;
      } else {
        if (value !== "all" && value !== "none") {
          return {
            mode: "error",
            message: `Invalid --resources "${value}" (expected "all" or "none")`,
          };
        }
        resources = value;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      return { mode: "error", message: `Unknown option: ${arg}` };
    }

    if (slug !== undefined) {
      return { mode: "error", message: `Unexpected argument: ${arg}` };
    }
    if (!SLUG_RE.test(arg)) {
      return {
        mode: "error",
        message: `Invalid org name "${arg}" — must be lowercase alphanumeric with hyphens (e.g. my-org)`,
      };
    }
    slug = arg;
  }

  if (slug === undefined) {
    return {
      mode: "error",
      message: "Non-interactive setup needs an org name: npm run setup -- <org>",
    };
  }

  return { mode: "direct", options: { slug, region, resources } };
}

/** Read one KEY=value assignment from dotenv-style content. */
export function readEnvValue(content: string, key: string): string | undefined {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== key) continue;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

/** Placeholder values copied from .env.example should not count as a token. */
export function isPlaceholderToken(token: string): boolean {
  return /^your-.*-here$/i.test(token) || token === "<your-key>";
}
