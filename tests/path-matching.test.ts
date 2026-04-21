import test from "node:test";
import assert from "node:assert/strict";

// Regression tests for P0-7.
//
// push.ts depends on config.ts which calls process.exit(1) at module load
// time if VAPI_TOKEN is not set or if argv[2] is not a valid slug. Set both
// before dynamic-importing the module under test.
process.argv = ["node", "test", "test-fixture-org"];
process.env.VAPI_TOKEN = process.env.VAPI_TOKEN || "test-token-not-used";

const { pathMatchesFolder } = await import("../src/push.ts");

// The bug:
//   shouldApplyResourceType used `fp.includes("/" + folder + "/")`, which
//   requires a leading slash. So `assistants/foo.yml` (the natural CLI short
//   form documented in AGENTS.md) silently no-op'd:
//     - shouldApplyResourceType returned false → the type was never loaded
//     - filterResourcesByPaths was never even consulted
//     - exit code was 0, "Applied 0 resource(s)"
//   These tests pin the behavior across the path shapes a user can pass.

test("matches a long-form path (resources/<org>/<folder>/file.yml)", () => {
  assert.equal(
    pathMatchesFolder(
      "resources/my-org/assistants/support-bot.yml",
      "assistants",
    ),
    true,
  );
});

test("matches a long-form path with leading ./", () => {
  assert.equal(
    pathMatchesFolder(
      "./resources/my-org/assistants/support-bot.yml",
      "assistants",
    ),
    true,
  );
});

test("matches an absolute path", () => {
  assert.equal(
    pathMatchesFolder(
      "/Users/dev/work/gitops/resources/my-org/assistants/support-bot.yml",
      "assistants",
    ),
    true,
  );
});

test(
  "P0-7 regression: matches a SHORT-form path (folder/file.yml) — this " +
    "previously silently no-op'd because the matcher required a leading slash",
  () => {
    assert.equal(
      pathMatchesFolder("assistants/support-bot.yml", "assistants"),
      true,
    );
  },
);

test("P0-7 regression: matches a short-form path with subdirectory", () => {
  assert.equal(
    pathMatchesFolder("assistants/support/intake.yml", "assistants"),
    true,
  );
});

test("matches a short-form path for nested folders (simulations/personalities)", () => {
  assert.equal(
    pathMatchesFolder(
      "simulations/personalities/rude-customer.yml",
      "simulations/personalities",
    ),
    true,
  );
  assert.equal(
    pathMatchesFolder(
      "resources/my-org/simulations/personalities/rude-customer.yml",
      "simulations/personalities",
    ),
    true,
  );
});

test("matches Windows-style short-form paths (assistants\\foo.yml)", () => {
  assert.equal(
    pathMatchesFolder("assistants\\support-bot.yml", "assistants"),
    true,
  );
});

test("matches Windows-style long-form paths", () => {
  assert.equal(
    pathMatchesFolder(
      "resources\\my-org\\assistants\\support-bot.yml",
      "assistants",
    ),
    true,
  );
});

test("rejects an unrelated folder", () => {
  assert.equal(
    pathMatchesFolder("tools/transferCall.yml", "assistants"),
    false,
  );
  assert.equal(
    pathMatchesFolder("resources/my-org/tools/transferCall.yml", "assistants"),
    false,
  );
});

test("rejects a path that contains the folder name as a substring of another segment", () => {
  // `assistants_legacy` should NOT match `assistants` because the segment
  // boundary is enforced.
  assert.equal(
    pathMatchesFolder("assistants_legacy/foo.yml", "assistants"),
    false,
  );
  assert.equal(
    pathMatchesFolder(
      "resources/my-org/assistants_legacy/foo.yml",
      "assistants",
    ),
    false,
  );
});

test("matches the bare folder name itself", () => {
  // `npm run push -- <org> assistants` (positional resource type) is parsed
  // by config.ts as a `resourceTypes` filter, not a `filePaths` filter, so in
  // practice this path won't be hit. But document the behavior anyway: bare
  // folder name matches.
  assert.equal(pathMatchesFolder("assistants", "assistants"), true);
});
