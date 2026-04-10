// Entry point for `npm run apply`. Detects whether an org slug was provided:
// - With slug: forwards to apply.ts (existing non-interactive behavior)
// - Without slug: enters interactive mode (org selection + confirm)

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const arg = process.argv[2];
const isSlug = arg && SLUG_RE.test(arg);

if (isSlug) {
  const { runApply } = await import("./apply.ts");
  await runApply().catch((error: unknown) => {
    console.error(
      "\n❌ Apply failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else if (!arg) {
  const { runInteractiveApply } = await import("./interactive.ts");
  await runInteractiveApply().catch((error: unknown) => {
    console.error(
      "\n❌ Apply failed:",
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
    "   Usage: npm run apply <org>  |  npm run apply (interactive)",
  );
  process.exit(1);
}
