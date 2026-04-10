// Entry point for `npm run cleanup`. Detects whether an org slug was provided:
// - With slug: forwards to cleanup.ts (existing non-interactive behavior)
// - Without slug: enters interactive mode (org selection + confirm)

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const arg = process.argv[2];
const isSlug = arg && SLUG_RE.test(arg);

if (isSlug) {
  const { runCleanup } = await import("./cleanup.ts");
  await runCleanup().catch((error: unknown) => {
    console.error(
      "\n❌ Cleanup failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else if (!arg) {
  const { runInteractiveCleanup } = await import("./interactive.ts");
  await runInteractiveCleanup().catch((error: unknown) => {
    console.error(
      "\n❌ Cleanup failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else {
  console.error(`❌ Invalid org name: ${arg}`);
  console.error(
    "   Must be lowercase alphanumeric with optional hyphens (e.g., dev, my-org)",
  );
  console.error(
    "   Usage: npm run cleanup <org>  |  npm run cleanup (interactive)",
  );
  process.exit(1);
}
