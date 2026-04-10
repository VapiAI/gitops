// Entry point for `npm run push`. Detects whether an org slug was provided:
// - With slug: forwards to push.ts (existing non-interactive behavior)
// - Without slug: enters interactive mode (org selection + resource picker)

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const arg = process.argv[2];
const isSlug = arg && SLUG_RE.test(arg);

if (isSlug) {
  const { runPush } = await import("./push.ts");
  await runPush().catch((error: unknown) => {
    console.error(
      "\n❌ Push failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else if (!arg) {
  const { runInteractivePush } = await import("./interactive.ts");
  await runInteractivePush().catch((error: unknown) => {
    console.error(
      "\n❌ Push failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else {
  console.error(`❌ Invalid org name: ${arg}`);
  console.error(
    "   Must be lowercase alphanumeric with optional hyphens (e.g., dev, my-org)",
  );
  console.error("   Usage: npm run push <org>  |  npm run push (interactive)");
  process.exit(1);
}
