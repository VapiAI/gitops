import assert from "node:assert/strict";
import test from "node:test";
import { adoptResources, parseAdoptArgs } from "../src/adopt.ts";
import type { RemoteResource } from "../src/dep-dedup.ts";
import type { TouchedSets } from "../src/state-merge.ts";
import type { LoadedResources, ResourceType, StateFile } from "../src/types.ts";
import { VALID_RESOURCE_TYPES } from "../src/types.ts";

function fixture() {
  const state = Object.fromEntries(
    ["credentials", ...VALID_RESOURCE_TYPES].map((t) => [t, {}]),
  ) as unknown as StateFile;
  const resources = Object.fromEntries(
    VALID_RESOURCE_TYPES.map((t) => [t, []]),
  ) as unknown as LoadedResources;
  resources.tools.push({
    resourceId: "stop",
    filePath: "tools/stop.yml",
    data: { function: { name: "End Call" } },
  });
  const touched = Object.fromEntries(
    ["credentials", ...VALID_RESOURCE_TYPES].map((t) => [t, new Set<string>()]),
  ) as unknown as TouchedSets;
  return {
    state,
    resources,
    touched,
    targets: ["stop"],
    dryRun: false,
    getRemoteList: async (_type: ResourceType): Promise<RemoteResource[]> => [
      { id: "remote", function: { name: "End Call" } },
    ],
  };
}

test("adopt argument forms are repeatable and malformed values fail", () => {
  assert.deepEqual(
    parseAdoptArgs([
      "--adopt",
      "stop",
      "--adopt=agent=id",
      "--adopt",
      "other=uuid",
    ]),
    ["stop", "agent=id", "other=uuid"],
  );
  for (const args of [
    ["--adopt"],
    ["--adopt="],
    ["--adopt", "--dry-run"],
    ["--adopt=x="],
    ["--adopt=x=y=z"],
  ]) {
    assert.throws(() => parseAdoptArgs(args), /requires/);
  }
  assert.deepEqual(parseAdoptArgs(["--dry-run", "tools"]), []);
});

test("single candidate is adopted, aliases removed, and scoped touched sets populated", async () => {
  const f = fixture();
  f.state.tools["stop-abcd1234"] = { uuid: "remote", origin: "pulled" };
  f.state.tools.alias = { uuid: "remote" };
  f.state.tools.unrelated = { uuid: "other" };
  await adoptResources(f);
  assert.deepEqual(f.state.tools.stop, { uuid: "remote", origin: "adopted" });
  assert.equal(f.state.tools["stop-abcd1234"], undefined);
  assert.equal(f.state.tools.alias, undefined);
  assert.deepEqual([...f.touched.tools].sort(), [
    "alias",
    "stop",
    "stop-abcd1234",
  ]);
  assert.deepEqual(f.state.tools.unrelated, { uuid: "other" });
});

test("explicit UUID selects an existing remote even with a different name", async () => {
  const f = fixture();
  f.targets = ["stop=chosen"];
  f.getRemoteList = async () => [
    { id: "remote", name: "End Call" },
    { id: "chosen", name: "Different" },
  ];
  await adoptResources(f);
  assert.deepEqual(f.state.tools.stop, { uuid: "chosen", origin: "adopted" });
});

test("ambiguous, missing, already linked, nonexistent UUID, and absent file all fail without linking", async () => {
  const cases = [
    {
      setup: (f: ReturnType<typeof fixture>) => {
        f.getRemoteList = async () => [
          { id: "a", name: "End Call" },
          { id: "b", name: "End Call" },
        ];
      },
      error: /ambiguous candidates: a, b.*--adopt stop=<uuid>/,
    },
    {
      setup: (f: ReturnType<typeof fixture>) => {
        f.getRemoteList = async () => [];
      },
      error: /no candidates/,
    },
    {
      setup: (f: ReturnType<typeof fixture>) => {
        f.state.tools.stop = { uuid: "linked" };
      },
      error: /already linked/,
    },
    {
      setup: (f: ReturnType<typeof fixture>) => {
        f.targets = ["stop=absent"];
      },
      error: /does not exist remotely/,
    },
    {
      setup: (f: ReturnType<typeof fixture>) => {
        f.targets = ["absent"];
      },
      error: /no such file/,
    },
  ];
  for (const { setup, error } of cases) {
    const f = fixture();
    setup(f);
    const before = structuredClone(f.state);
    await assert.rejects(adoptResources(f), error);
    assert.deepEqual(f.state, before);
  }
});

test("dry run looks up candidates and returns a preview without mutating state or touched", async () => {
  const f = fixture();
  f.dryRun = true;
  let lookups = 0;
  f.getRemoteList = async () => {
    lookups++;
    return [{ id: "remote", name: "End Call" }];
  };
  const preview = await adoptResources(f);
  assert.equal(lookups, 1);
  assert.deepEqual(f.state.tools, {});
  assert.equal(f.touched.tools.size, 0);
  assert.deepEqual(preview.tools.stop, { uuid: "remote", origin: "adopted" });
});

test("empty targets do not query; lookup errors fail closed", async () => {
  const f = fixture();
  f.getRemoteList = async () => {
    throw new Error("lookup failed");
  };
  f.targets = [];
  await adoptResources(f);
  f.targets = ["stop"];
  await assert.rejects(adoptResources(f), /lookup failed/);
});
