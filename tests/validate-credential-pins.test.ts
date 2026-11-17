import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialKinds } from "../src/credential-kinds.ts";
import type { LoadedResources, ResourceType, StateFile } from "../src/types.ts";
import { validateCredentialPins } from "../src/validate-credential-pins.ts";

// A credentialIds list is the only set of keys a call may use. The check
// fires when the list leaves out a key the org has saved for something the
// call uses, and stays quiet when the org has no key of its own for it.

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The keys a clinic group might save: one Azure OpenAI key per practice, and
// one of everything else.
const KINDS: CredentialKinds = {
  "azure-north": { provider: "azure-openai" },
  "azure-south": { provider: "azure-openai" },
  elevenlabs: { provider: "11labs" },
  deepgram: { provider: "deepgram" },
  "crm-webhook": { provider: "webhook" },
  recordings: { provider: "azure", bucket: true },
  "main-line": { provider: "twilio" },
};
const FULL_PIN = ["elevenlabs", "deepgram", "crm-webhook", "recordings"];

function loaded(
  files: Partial<Record<ResourceType, Record<string, object>>>,
): LoadedResources {
  const list = (type: ResourceType) =>
    Object.entries(files[type] ?? {}).map(([resourceId, data]) => ({
      resourceId,
      filePath: `/repo/resources/clinic/${type}/${resourceId}.yml`,
      data: data as Record<string, unknown>,
    }));
  return {
    tools: list("tools"),
    structuredOutputs: list("structuredOutputs"),
    assistants: list("assistants"),
    squads: list("squads"),
    personalities: list("personalities"),
    scenarios: list("scenarios"),
    simulations: list("simulations"),
    simulationSuites: list("simulationSuites"),
    evals: list("evals"),
  };
}

function state(kinds: CredentialKinds, tools: string[] = []): StateFile {
  const section = (ids: string[], offset: number) =>
    Object.fromEntries(ids.map((id, i) => [id, { uuid: uuid(offset + i) }]));
  return {
    credentials: section(Object.keys(kinds), 100),
    tools: section(tools, 200),
    assistants: {},
    structuredOutputs: {},
    squads: {},
    personalities: {},
    scenarios: {},
    simulations: {},
    simulationSuites: {},
    evals: {},
  };
}

// Each finding as "severity rule type/resource: message".
function check(
  files: Partial<Record<ResourceType, Record<string, object>>>,
  options: {
    kinds?: CredentialKinds | null;
    customerKeysOnly?: boolean;
    stateKinds?: CredentialKinds;
  } = {},
): string[] {
  const kinds = options.kinds === null ? undefined : (options.kinds ?? KINDS);
  return validateCredentialPins({
    loaded: loaded(files),
    org: "clinic",
    state: state(
      options.stateKinds ?? kinds ?? KINDS,
      Object.keys(files.tools ?? {}),
    ),
    kinds,
    customerKeysOnly: options.customerKeysOnly ?? false,
  }).map(
    (f) => `${f.severity} ${f.rule} ${f.type}/${f.resourceId}: ${f.message}`,
  );
}

const triage = {
  name: "Triage",
  model: { provider: "openai", model: "gpt-4.1" },
  voice: { provider: "11labs", voiceId: "sarah" },
  transcriber: { provider: "deepgram", model: "nova-3" },
};
const pharmacy = { ...triage, name: "Pharmacy" };

const frontDesk = (membersOverrides: object, members?: object[]) => ({
  name: "Front Desk",
  members: members ?? [{ assistantId: "triage" }, { assistantId: "pharmacy" }],
  membersOverrides,
});

test("no credentialIds list, no finding, whatever keys the org has", () => {
  assert.deepEqual(
    check({
      assistants: { triage, pharmacy },
      squads: { "front-desk": frontDesk({}) },
    }),
    [],
  );
});

test("a list that names every key the call uses passes", () => {
  assert.deepEqual(
    check({
      assistants: { triage, pharmacy },
      squads: {
        "front-desk": frontDesk({
          credentialIds: ["azure-south", ...FULL_PIN],
        }),
      },
    }),
    [],
  );
});

test("a squad list that leaves out the saved voice key is reported once, for every member", () => {
  const found = check({
    assistants: { triage, pharmacy },
    squads: {
      "front-desk": frontDesk({
        credentialIds: ["azure-south", "deepgram", "crm-webhook", "recordings"],
      }),
    },
  });
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /^warn credential-pin-hides-key squads\/front-desk: /,
  );
  assert.match(
    found[0]!,
    /the voice of member "triage" and the voice of member "pharmacy" use 11labs, and this org has "elevenlabs" saved for it/,
  );
  assert.match(found[0]!, /11labs would run on Vapi's own key, not yours/);
});

test("it is an error in an org marked customer-keys-only", () => {
  const found = check(
    {
      assistants: { triage, pharmacy },
      squads: { "front-desk": frontDesk({ credentialIds: ["azure-south"] }) },
    },
    { customerKeysOnly: true },
  );
  // Voice, transcriber and the storage bucket are all hidden.
  assert.equal(found.length, 3);
  for (const line of found)
    assert.match(line, /^error credential-pin-hides-key squads\/front-desk: /);
});

test("a provider the org has no key of its own for is left alone", () => {
  // No ElevenLabs or Deepgram key saved: those run on Vapi's keys on purpose.
  const kinds: CredentialKinds = {
    "azure-south": { provider: "azure-openai" },
  };
  assert.deepEqual(
    check(
      {
        assistants: { triage, pharmacy },
        squads: { "front-desk": frontDesk({ credentialIds: ["azure-south"] }) },
      },
      { kinds, customerKeysOnly: true },
    ),
    [],
  );
});

test("another key for the same provider counts: one practice's key, not the other's", () => {
  assert.deepEqual(
    check({
      assistants: { triage, pharmacy },
      squads: {
        "front-desk": frontDesk({
          credentialIds: ["azure-north", ...FULL_PIN],
        }),
      },
    }),
    [],
  );
});

test("an OpenAI model is served by an openai key or an azure-openai key", () => {
  const kinds: CredentialKinds = {
    "azure-south": { provider: "azure-openai" },
    "openai-direct": { provider: "openai" },
    elevenlabs: { provider: "11labs" },
  };
  const assistant = { ...triage, transcriber: undefined };
  const withPin = (credentialIds: string[]) =>
    check(
      { assistants: { triage: { ...assistant, credentialIds } } },
      { kinds },
    );
  // Either kind of key on the list is a key for the model.
  assert.deepEqual(withPin(["azure-south", "elevenlabs"]), []);
  assert.deepEqual(withPin(["openai-direct", "elevenlabs"]), []);
  // Neither on the list: both saved keys are hidden.
  const found = withPin(["elevenlabs"]);
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /the model of this assistant uses openai, and this org has "azure-south", "openai-direct" saved for it/,
  );
});

test("a member's own assistantOverrides list is replaced by the squad's", () => {
  // The member names the voice key, but membersOverrides wins key by key.
  const found = check({
    assistants: { triage },
    squads: {
      "front-desk": frontDesk(
        { credentialIds: ["azure-south", "deepgram", "recordings"] },
        [
          {
            assistantId: "triage",
            assistantOverrides: { credentialIds: ["elevenlabs"] },
          },
        ],
      ),
    },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /uses 11labs/);
});

test("an assistant's own list is kept, and the squad's is added to it", () => {
  const found = check({
    assistants: {
      triage: {
        ...triage,
        credentialIds: ["azure-south", "elevenlabs", "recordings"],
      },
    },
    squads: {
      "front-desk": frontDesk({ credentialIds: ["deepgram"] }, [
        { assistantId: "triage" },
      ]),
    },
  });
  // In the squad the two lists together cover the call. Called on its own,
  // the assistant has only its own list, which has no transcriber key.
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /^warn credential-pin-hides-key assistants\/triage: the transcriber of this assistant uses deepgram/,
  );
});

test("one member's list narrows the whole call", () => {
  // Only pharmacy has a list, yet triage's voice loses its key as well.
  const found = check(
    {
      assistants: {
        triage,
        pharmacy: {
          ...pharmacy,
          credentialIds: [
            "azure-south",
            "deepgram",
            "elevenlabs",
            "recordings",
          ],
        },
        scheduler: {
          name: "Scheduler",
          model: { provider: "anthropic", model: "claude" },
          voice: { provider: "cartesia", voiceId: "x" },
        },
      },
      squads: {
        "front-desk": frontDesk({}, [
          { assistantId: "triage" },
          { assistantId: "pharmacy" },
          { assistantId: "scheduler" },
        ]),
      },
    },
    {
      kinds: { ...KINDS, "cartesia-key": { provider: "cartesia" } },
    },
  );
  assert.deepEqual(
    found.map((line) => line.replace(/, and this org[\s\S]*$/, "")),
    [
      'warn credential-pin-hides-key squads/front-desk: the voice of member "scheduler" uses cartesia',
    ],
  );
});

test("an override that changes the provider is what gets checked", () => {
  const found = check(
    {
      assistants: { triage },
      squads: {
        "front-desk": frontDesk(
          {
            credentialIds: [
              "azure-south",
              "elevenlabs",
              "deepgram",
              "recordings",
            ],
            voice: { provider: "cartesia", voiceId: "x" },
          },
          [{ assistantId: "triage" }],
        ),
      },
    },
    { kinds: { ...KINDS, "cartesia-key": { provider: "cartesia" } } },
  );
  assert.equal(found.length, 1);
  assert.match(found[0]!, /the voice of member "triage" uses cartesia/);
});

test("fallback voices and transcribers are checked like the primary", () => {
  const found = check({
    assistants: {
      triage: {
        ...triage,
        voice: {
          provider: "vapi",
          voiceId: "Elliot",
          fallbackPlan: { voices: [{ provider: "11labs", voiceId: "sarah" }] },
        },
        credentialIds: ["azure-south", "deepgram", "recordings"],
      },
    },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /the fallback voice of this assistant uses 11labs/);
});

test("a key a tool or server names must be on the list", () => {
  const lookup = {
    type: "apiRequest",
    url: "https://example.com/lookup",
    credentialId: "crm-webhook",
  };
  const files = (credentialIds: string[]) => ({
    tools: { lookup },
    assistants: {
      triage: {
        ...triage,
        model: { ...triage.model, toolIds: ["lookup"] },
        server: {
          url: "https://example.com/events",
          credentialId: "crm-webhook",
        },
        credentialIds,
      },
    },
  });
  assert.deepEqual(
    check(
      files([
        "azure-south",
        "elevenlabs",
        "deepgram",
        "recordings",
        "crm-webhook",
      ]),
    ),
    [],
  );
  const found = check(
    files(["azure-south", "elevenlabs", "deepgram", "recordings"]),
  );
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /this assistant and tool "lookup" name credential "crm-webhook", but the call's credentialIds list .* leaves it out/,
  );
  assert.match(found[0]!, /that request would go out without the key/);
});

test("a tool appended in an override is read too", () => {
  const found = check({
    assistants: { triage },
    squads: {
      "front-desk": frontDesk(
        {
          credentialIds: [
            "azure-south",
            "elevenlabs",
            "deepgram",
            "recordings",
          ],
          "tools:append": [
            {
              type: "function",
              server: {
                url: "https://example.com",
                credentialId: "crm-webhook",
              },
            },
          ],
        },
        [{ assistantId: "triage" }],
      ),
    },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!, /member "triage" names credential "crm-webhook"/);
});

test("the storage bucket key is used by every call", () => {
  const pinned = {
    ...triage,
    credentialIds: ["azure-south", "elevenlabs", "deepgram"],
  };
  const found = check({ assistants: { triage: pinned } });
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /this org has a storage bucket key saved \("recordings"\).*would not go to your bucket/,
  );
  // An azure, gcp or supabase key without a bucket is not storage.
  assert.deepEqual(
    check(
      { assistants: { triage: pinned } },
      { kinds: { ...KINDS, recordings: { provider: "azure" } } },
    ),
    [],
  );
  // An s3 key always is.
  assert.equal(
    check(
      { assistants: { triage: pinned } },
      { kinds: { ...KINDS, recordings: { provider: "s3" } } },
    ).length,
    1,
  );
});

test("a saved Langfuse key left off the list is reported", () => {
  const found = check(
    {
      assistants: {
        triage: { ...triage, credentialIds: ["azure-south", ...FULL_PIN] },
      },
    },
    { kinds: { ...KINDS, tracing: { provider: "langfuse" } } },
  );
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /Langfuse key saved \("tracing"\).*would not be traced/,
  );
});

test("a phone number's credential never has to be listed", () => {
  // The call keeps its phone number's key whatever the list says.
  assert.deepEqual(
    check(
      {
        assistants: {
          triage: {
            name: "Triage",
            model: { provider: "vapi" },
            voice: { provider: "11labs", voiceId: "sarah" },
            credentialIds: ["elevenlabs"],
          },
        },
      },
      {
        kinds: {
          elevenlabs: { provider: "11labs" },
          "main-line": { provider: "twilio" },
          trunk: { provider: "byo-sip-trunk" },
        },
        customerKeysOnly: true,
      },
    ),
    [],
  );
});

test("a key written inline on the assistant covers its provider", () => {
  assert.deepEqual(
    check({
      assistants: {
        triage: {
          ...triage,
          credentials: [{ provider: "11labs", apiKey: "…" }],
          credentialIds: ["azure-south", "deepgram", "recordings"],
        },
      },
    }),
    [],
  );
});

test("a list written as UUIDs is read through the state file", () => {
  const names = Object.keys(KINDS);
  const id = (name: string) => uuid(100 + names.indexOf(name));
  assert.deepEqual(
    check({
      assistants: {
        triage: {
          ...triage,
          credentialIds: ["azure-south", ...FULL_PIN].map(id),
        },
      },
    }),
    [],
  );
});

test("without the credential kinds file the check says so once, and still checks named keys", () => {
  const pinned = (name: string) => ({
    ...triage,
    name,
    server: { url: "https://example.com", credentialId: "crm-webhook" },
    credentialIds: ["azure-south"],
  });
  const found = check(
    { assistants: { triage: pinned("Triage"), pharmacy: pinned("Pharmacy") } },
    { kinds: null, customerKeysOnly: true },
  );
  assert.deepEqual(
    found.map((line) => line.split(": ")[0]),
    [
      "error credential-pin-hides-key assistants/triage",
      "error credential-pin-unchecked assistants/triage",
      "error credential-pin-hides-key assistants/pharmacy",
    ],
  );
  assert.match(
    found[1]!,
    /state\/clinic\/credential-providers\.json doesn't exist yet.*npm run pull -- clinic --bootstrap/,
  );
});

test("a credential newer than the kinds file makes the check ask for a pull", () => {
  const found = check(
    { assistants: { triage: { ...triage, credentialIds: ["azure-south"] } } },
    {
      kinds: { "azure-south": { provider: "azure-openai" } },
      stateKinds: KINDS,
    },
  );
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /credential-pin-unchecked .* has no entry for "azure-north"/,
  );
});

test("a name on the list that nothing knows is reported, not guessed at", () => {
  const found = check({
    assistants: {
      triage: { ...triage, credentialIds: ["azure-suoth", ...FULL_PIN] },
    },
  });
  assert.equal(found.length, 1);
  assert.match(
    found[0]!,
    /credential-pin-unchecked assistants\/triage: credentialIds lists "azure-suoth", which this repo has no record of/,
  );
});
