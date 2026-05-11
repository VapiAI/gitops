import assert from "node:assert/strict";
import test from "node:test";
import { checkPronunciationDictDrop } from "../src/state-serialize.ts";

// Stack G — drift unit tests.
// `checkDriftForUpdate` itself fires GET against the Vapi platform; a unit
// test for that path requires either a fake fetch or live API access. Manual
// integration coverage is the right place. Here we cover the
// pronunciation-dict-drop detector, which is pure-data.

test("checkPronunciationDictDrop: warns when prior had ID and new lost it", () => {
  const prior = {
    voice: { provider: "cartesia", pronunciationDictId: "pdict_X" },
  };
  const current = { voice: { provider: "cartesia" } };
  const msg = checkPronunciationDictDrop("agent-foo", prior, current);
  assert.ok(msg, "expected a warning message");
  assert.match(msg!, /pdict_X/);
  assert.match(msg!, /agent-foo/);
});

test("checkPronunciationDictDrop: silent when both have it", () => {
  const prior = { voice: { pronunciationDictId: "pdict_X" } };
  const current = { voice: { pronunciationDictId: "pdict_X" } };
  assert.equal(checkPronunciationDictDrop("agent-foo", prior, current), null);
});

test("checkPronunciationDictDrop: silent when neither has it", () => {
  const prior = { voice: {} };
  const current = { voice: {} };
  assert.equal(checkPronunciationDictDrop("agent-foo", prior, current), null);
});

test("checkPronunciationDictDrop: silent when prior didn't have it (additive change)", () => {
  const prior = { voice: {} };
  const current = { voice: { pronunciationDictId: "pdict_X" } };
  assert.equal(checkPronunciationDictDrop("agent-foo", prior, current), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 11labs `pronunciationDictionaryLocators` array shape (Vapi-documented).
// https://docs.vapi.ai/assistants/pronunciation-dictionaries
// ─────────────────────────────────────────────────────────────────────────────

test("checkPronunciationDictDrop: warns when 11labs locator array clears (1 → 0)", () => {
  const prior = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        {
          pronunciationDictionaryId: "rjshI10OgN6KxqtJBqO4",
          versionId: "xJl0ImZzi3cYp61T0UQG",
        },
      ],
    },
  };
  const current = {
    voice: { provider: "11labs", pronunciationDictionaryLocators: [] },
  };
  const msg = checkPronunciationDictDrop("eleven-agent", prior, current);
  assert.ok(msg, "expected a warning message");
  assert.match(msg!, /pronunciationDictionaryLocators/);
  assert.match(msg!, /1 entry\/entries .* to 0/);
  assert.match(msg!, /eleven-agent/);
});

test("checkPronunciationDictDrop: warns when 11labs locator array shrinks (2 → 1)", () => {
  const prior = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
        { pronunciationDictionaryId: "id_b", versionId: "v_b" },
      ],
    },
  };
  const current = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const msg = checkPronunciationDictDrop("eleven-agent", prior, current);
  assert.ok(msg, "expected a warning message for partial drop");
  assert.match(msg!, /2 entry\/entries .* to 1/);
});

test("checkPronunciationDictDrop: warns when 11labs locator array goes missing entirely", () => {
  const prior = {
    voice: {
      provider: "11labs",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const current = { voice: { provider: "11labs" } };
  const msg = checkPronunciationDictDrop("eleven-agent", prior, current);
  assert.ok(msg, "expected a warning message when array missing");
  assert.match(msg!, /1 entry\/entries .* to 0/);
});

test("checkPronunciationDictDrop: silent when 11labs locator array is unchanged", () => {
  const locators = [{ pronunciationDictionaryId: "id_a", versionId: "v_a" }];
  const prior = { voice: { pronunciationDictionaryLocators: locators } };
  const current = { voice: { pronunciationDictionaryLocators: [...locators] } };
  assert.equal(
    checkPronunciationDictDrop("eleven-agent", prior, current),
    null,
  );
});

test("checkPronunciationDictDrop: silent when 11labs locator array grows (additive)", () => {
  const prior = {
    voice: {
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const current = {
    voice: {
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
        { pronunciationDictionaryId: "id_b", versionId: "v_b" },
      ],
    },
  };
  assert.equal(
    checkPronunciationDictDrop("eleven-agent", prior, current),
    null,
  );
});

test("checkPronunciationDictDrop: detects either shape when prior has both somehow (Cartesia wins; 11labs check still runs)", () => {
  // Defensive — a payload that happens to carry both shapes (shouldn't
  // happen in practice but the function should not crash). The Cartesia
  // single-id check runs first; if it fires we return that message. If it
  // doesn't (because new still has Cartesia id), the 11labs check runs.
  const prior = {
    voice: {
      pronunciationDictId: "pdict_X",
      pronunciationDictionaryLocators: [
        { pronunciationDictionaryId: "id_a", versionId: "v_a" },
      ],
    },
  };
  const current = {
    voice: {
      pronunciationDictId: "pdict_X",
      pronunciationDictionaryLocators: [],
    },
  };
  const msg = checkPronunciationDictDrop("hybrid-agent", prior, current);
  assert.ok(msg, "expected a warning when locators dropped");
  assert.match(msg!, /pronunciationDictionaryLocators/);
});
