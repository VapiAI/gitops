import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { orgEnvFilesRead } from "../src/env-file.ts";

test("shared env parser supports comments, exports, quoted lines and duplicate assignments", () => {
  const root = mkdtempSync(join(tmpdir(), "env-parser-"));
  try {
    for (const [input, expected] of [
      ["KEY=value # note", "value"],
      ["KEY=value#fragment", "value"],
      ['KEY="value" # note', "value"],
      ["export KEY=value", "value"],
      ['KEY="line1\\nline2"', "line1\nline2"],
      ['KEY="line1\nline2"', "line1\nline2"],
      ["KEY=`value`", "value"],
      ["KEY=first\nKEY=last", "last"],
      ["KEY='value#fragment'", "value#fragment"],
    ]) {
      writeFileSync(join(root, ".env.acme"), input!);
      assert.equal(
        orgEnvFilesRead(root, "acme")[0]!.values.KEY,
        expected,
        input,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
