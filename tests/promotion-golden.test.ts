import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import type { PromotionBindings } from "../src/promotion.ts";
import {
  promotionPlanApply,
  promotionPlanBuild,
  promotionStateParse,
} from "../src/promotion.ts";

// Golden test for moving an assistant from a lower org into production: the
// exact files promotion writes into the target org. Each piece is covered
// elsewhere; this pins the whole written output, so a refactor that drifts
// any of it (reference canonicalization, dependency selection, credential or
// phone bindings, deletions, untouched unrelated files, markdown bodies)
// fails here. Update the expected output only for an intended change.

const FILES: Record<string, string> = {
  "resources/staging/assistants/intake.md":
    "---\nname: Intake\nfirstMessage: Thanks for calling, how can I help?\nmodel:\n  provider: openai\n  model: gpt-4.1\n  toolIds:\n    - 11111111-1111-4111-8111-111111111111\n    - handoff-to-billing\n  tools:\n    - type: endCall\nvoice:\n  provider: 11labs\n  voiceId: sarah\n  credentialId: 22222222-2222-4222-8222-222222222222\nphoneNumberIds:\n  - staging-phone\n---\n\nYou are the intake agent. Ask for the caller's account number first.\n",
  "resources/staging/assistants/billing.yml":
    "name: Billing\nmodel:\n  provider: openai\n  model: gpt-4.1\n",
  "resources/staging/tools/lookup.yml":
    "type: function\nfunction:\n  name: lookup_account\n  parameters:\n    type: object\n    properties:\n      accountNumber:\n        type: string\nserver:\n  url: https://crm.example.com/vapi\n  credentialId: crm\n",
  "resources/staging/tools/handoff-to-billing.yml":
    "type: handoff\ndestinations:\n  - type: assistant\n    assistantId: 33333333-3333-4333-8333-333333333333\n    description: Billing questions\n",
  "resources/staging/tools/staging-only-debug.yml":
    "type: function\nfunction:\n  name: debug_dump\n",
  "resources/prod/assistants/intake.md":
    "---\nname: Intake\nmodel:\n  provider: openai\n  model: gpt-4o\n---\n\nOld prompt.\n",
  "resources/prod/assistants/retired.yml": "name: Retired\n",
  "resources/prod/squads/keep.yml": "name: Unrelated squad\n",
  ".env.staging": "VAPI_PHONE_NUMBER_MAIN=staging-phone\n",
  ".env.prod": "VAPI_PHONE_NUMBER_MAIN=prod-phone\n",
};

const SOURCE_STATE = {
  tools: {
    lookup: {
      uuid: "11111111-1111-4111-8111-111111111111",
    },
  },
  assistants: {
    billing: {
      uuid: "33333333-3333-4333-8333-333333333333",
    },
    retired: {
      uuid: "44444444-4444-4444-8444-444444444444",
    },
  },
  credentials: {
    eleven: {
      uuid: "22222222-2222-4222-8222-222222222222",
    },
    crm: {
      uuid: "55555555-5555-4555-8555-555555555555",
    },
  },
};

const TARGET_STATE = {
  assistants: {
    intake: {
      uuid: "66666666-6666-4666-8666-666666666666",
    },
    retired: {
      uuid: "77777777-7777-4777-8777-777777777777",
    },
  },
  credentials: {
    eleven: {
      uuid: "prod-eleven",
    },
    crm: {
      uuid: "prod-crm",
    },
  },
};

const BINDINGS: PromotionBindings = {
  credentials: {
    default: "bind",
    aliases: {},
  },
  phoneNumbers: {
    default: "omit",
    aliases: {
      main: "bind",
    },
  },
};

const EXPECTED_TARGET: Record<string, string> = {
  "assistants/billing.yml":
    "name: Billing\nmodel:\n  provider: openai\n  model: gpt-4.1\n",
  "assistants/intake.md": [
    "---",
    "name: Intake",
    "firstMessage: Thanks for calling, how can I help?",
    "model:",
    "  provider: openai",
    "  model: gpt-4.1",
    "  toolIds:",
    "    - lookup",
    "    - handoff-to-billing",
    "  tools:",
    "    - type: endCall",
    "voice:",
    "  provider: 11labs",
    "  voiceId: sarah",
    "  credentialId: eleven",
    "phoneNumberIds:",
    "  - prod-phone",
    "---",
    "",
    "You are the intake agent. Ask for the caller's account number first.",
    "",
  ].join("\n"),
  "squads/keep.yml": "name: Unrelated squad\n",
  "tools/handoff-to-billing.yml": [
    "type: handoff",
    "destinations:",
    "  - type: assistant",
    "    assistantId: billing",
    "    description: Billing questions",
    "",
  ].join("\n"),
  "tools/lookup.yml": [
    "type: function",
    "function:",
    "  name: lookup_account",
    "  parameters:",
    "    type: object",
    "    properties:",
    "      accountNumber:",
    "        type: string",
    "server:",
    "  url: https://crm.example.com/vapi",
    "  credentialId: crm",
    "",
  ].join("\n"),
};

async function fixtureWrite(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vapi-promotion-golden-"));
  for (const [path, content] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function filesRead(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out[relative(dir, full)] = await readFile(full, "utf8");
    }
  };
  await walk(dir);
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function planArgs(root: string) {
  return {
    rootDir: root,
    source: "staging",
    target: "prod",
    patterns: ["assistants/**"],
    sourceState: promotionStateParse(JSON.stringify(SOURCE_STATE)),
    targetState: promotionStateParse(JSON.stringify(TARGET_STATE)),
    bindings: BINDINGS,
  };
}

test("promoting an assistant writes exactly the expected target files", async () => {
  const root = await fixtureWrite();
  try {
    const plan = await promotionPlanBuild(planArgs(root));
    const changes = plan.changes.map((change) => [change.kind, change.path]);
    await promotionPlanApply(plan);
    assert.deepEqual(
      {
        changes,
        target: await filesRead(join(root, "resources/prod")),
        source: await filesRead(join(root, "resources/staging")),
      },
      {
        changes: [
          ["create", "assistants/billing.yml"],
          ["update", "assistants/intake.md"],
          ["delete", "assistants/retired.yml"],
          ["create", "tools/handoff-to-billing.yml"],
          ["create", "tools/lookup.yml"],
        ],
        target: EXPECTED_TARGET,
        // Promotion only ever writes the target org.
        source: Object.fromEntries(
          Object.entries(FILES)
            .filter(([path]) => path.startsWith("resources/staging/"))
            .map(([path, content]): [string, string] => [
              path.slice("resources/staging/".length),
              content,
            ])
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("re-planning right after an apply finds nothing left to change", async () => {
  const root = await fixtureWrite();
  try {
    await promotionPlanApply(await promotionPlanBuild(planArgs(root)));
    const again = await promotionPlanBuild(planArgs(root));
    assert.deepEqual(again.changes, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
