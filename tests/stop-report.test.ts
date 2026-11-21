import assert from "node:assert/strict";
import test from "node:test";
import {
  formatStopReport,
  jsonStopReport,
  type StopIssue,
  shellQuote,
} from "../src/stop-report.ts";

const issue = (id: string): StopIssue => ({
  file: `assistants/${id}.md`,
  resourceType: "assistants",
  problem: "Not linked yet",
  fix: "Explicitly approve adoption",
  command: `npm run push -- test --adopt ${id} assistants/${id}.md`,
  args: [`--adopt ${id}`, `assistants/${id}.md`],
});
test("one grouped report ends with one combined command for unique suggestions", () => {
  const output = formatStopReport([issue("foo"), issue("bar")], "test");
  assert.equal(output.match(/Push stopped:/g)?.length, 1);
  assert.match(
    output,
    /Suggested command.*npm run push -- test --adopt foo assistants\/foo.md --adopt bar assistants\/bar.md/,
  );
  assert.doesNotMatch(output, /orphan/i);
});
test("a human choice prevents a combined command", () => {
  const output = formatStopReport(
    [{ ...issue("foo"), needsChoice: true }],
    "test",
  );
  assert.match(output, /Human choice needed: assistants\/foo.md/);
  assert.doesNotMatch(output, /Suggested command/);
});
test("JSON is an array of only the documented fields, including empty reports", () => {
  assert.deepEqual(Object.keys(JSON.parse(jsonStopReport([issue("foo")]))[0]), [
    "file",
    "resourceType",
    "problem",
    "fix",
    "command",
  ]);
  assert.equal(jsonStopReport([]), "[]");
  assert.equal(shellQuote("path with spaces"), "'path with spaces'");
});
