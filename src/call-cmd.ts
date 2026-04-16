// Entry point for `npm run call`. Detects whether an org slug was provided:
// - With slug + flags: forwards to call.ts (existing non-interactive behavior)
// - Without slug: enters interactive mode (org selection + resource picker)

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const arg = process.argv[2];
const isSlug = arg && SLUG_RE.test(arg);

if (isSlug) {
  const { runCall } = await import("./call.ts");
  await runCall().catch((error: unknown) => {
    console.error(
      "\n❌ Call failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
} else if (!arg) {
  const { runInteractiveCall } = await import("./interactive.ts");
  await runInteractiveCall().catch((error: unknown) => {
    console.error(
      "\n❌ Call failed:",
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
    "   Usage: npm run call <org> -a <name>  |  npm run call (interactive)",
  );
  process.exit(1);
}
