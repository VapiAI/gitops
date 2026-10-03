import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every relative link and #anchor in the docs must resolve. The README links
// into a set of guides that link to each other, so renaming a file or a
// heading would otherwise break links silently.

const REPO = fileURLToPath(new URL("..", import.meta.url));

function markdownFiles(): string[] {
  const files = readdirSync(REPO).filter((name) => name.endsWith(".md"));
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  walk("docs");
  walk("examples");
  return files.sort();
}

const withoutCode = (text: string) => text.replace(/```[\s\S]*?```/g, "");

// GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes.
function anchorsOf(file: string): Set<string> {
  const text = withoutCode(readFileSync(file, "utf8"));
  return new Set(
    [...text.matchAll(/^#{1,6} (.*)$/gm)].map((match) =>
      match[1]!
        .toLowerCase()
        .trim()
        .replace(/[^\w\- ]+/g, "")
        .replace(/ /g, "-"),
    ),
  );
}

test("every relative link and anchor in the docs resolves", () => {
  const files = markdownFiles();
  const broken: string[] = [];
  for (const file of files) {
    const text = withoutCode(readFileSync(join(REPO, file), "utf8"));
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1]!;
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [path, anchor] = link.split("#");
      const target = path
        ? normalize(join(REPO, dirname(file), decodeURIComponent(path)))
        : join(REPO, file);
      if (!existsSync(target)) {
        broken.push(`${file}: ${link} (no such file)`);
        continue;
      }
      if (
        anchor &&
        statSync(target).isFile() &&
        target.endsWith(".md") &&
        !anchorsOf(target).has(anchor)
      )
        broken.push(
          `${file}: ${link} (no heading #${anchor} in ${relative(REPO, target)})`,
        );
    }
  }
  assert.ok(
    files.length > 20,
    `expected the docs tree, found ${files.length} files`,
  );
  assert.deepEqual(broken, []);
});
