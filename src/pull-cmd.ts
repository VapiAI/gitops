// Entry point for `npm run pull`. Detects whether an org slug was provided:
// - With slug: forwards to pull.ts (existing non-interactive behavior)
// - Without slug: enters interactive mode (org selection + resource picker)

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const arg = process.argv[2];
const isSlug = arg && SLUG_RE.test(arg);

if (isSlug) {
  const { runPull } = await import("./pull.ts");
  await runPull().catch((error: unknown) => {
    console.error(
      "\n❌ Pull failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else if (!arg) {
  const { runInteractivePull } = await import("./interactive.ts");
  await runInteractivePull().catch((error: unknown) => {
    console.error(
      "\n❌ Pull failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else {
  console.error(`❌ Invalid org name: ${arg}`);
  console.error(
    "   Must be lowercase alphanumeric with optional hyphens (e.g., dev, my-org)",
  );
  console.error("   Usage: npm run pull <org>  |  npm run pull (interactive)");
  process.exit(1);
}
