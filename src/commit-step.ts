// What the engine can read of the step that commits state after a run.
//
// A run in CI writes state and leaves committing it to a later step the
// engine can't watch. `npm run migrate` moves state into state/ without being
// told to only when a workflow is seen to stage state/, and a CI run stops
// when the workflow running it is seen not to. So this reader fails closed: a
// job counts as staging state/ only for a `git add` it can place, which means
// a plain command in a `run:` step, run from the repository root, that names
// `state` or stages everything. Whatever it can't place counts for nothing: a
// `git add` after a `cd`, inside a quoted string, behind a variable, in a
// helper script or in a commit action.
//
// Config-free, like state-paths.ts.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

export type CommitStep =
  /** Every job that shows a commit step is seen to stage state/. */
  | { kind: "seen"; stagesOld: boolean }
  /** A job is seen to stage the old state file and nothing that could be state/. */
  | { kind: "stale"; file: string }
  /** A job may commit state after a run, and it isn't seen to stage state/. */
  | { kind: "unseen"; file: string }
  /** No workflow here shows a commit step at all. */
  | { kind: "none" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── A `run:` script, one command at a time ───────────────────────────────

interface ShellWord {
  text: string;
  /** Holds a variable or a command substitution, so its value isn't known. */
  dynamic: boolean;
}

interface ShellCommand {
  words: ShellWord[];
  /** The operator between the command before and this one. */
  after: string;
}

// The end of a "$(" or "(" that opens at `open`, skipping quoted text.
function parenEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === "'") {
      i = text.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (ch === '"') {
      i = doubleQuoteEnd(text, i);
      if (i < 0) return -1;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

// The closing quote of a double-quoted string that opens at `open`. A "$("
// inside it can hold quotes of its own.
function doubleQuoteEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === '"') return i;
    else if (ch === "$" && text[i + 1] === "(") {
      i = parenEnd(text, i + 1);
      if (i < 0) return -1;
    }
  }
  return -1;
}

// Split a script into its commands. `complete` is false when the script holds
// something this doesn't read (a here-document, an unclosed quote): what
// follows it is not returned.
function shellCommandsRead(script: string): {
  commands: ShellCommand[];
  complete: boolean;
} {
  const text = script.replace(/\\\r?\n/g, "");
  const commands: ShellCommand[] = [];
  let words: ShellWord[] = [];
  let word: ShellWord | undefined;
  let after = "\n";
  const put = (chunk: string, dynamic = false): void => {
    word ??= { text: "", dynamic: false };
    word.text += chunk;
    word.dynamic ||= dynamic;
  };
  const wordEnd = (): void => {
    if (word) words.push(word);
    word = undefined;
  };
  const commandEnd = (operator: string): void => {
    wordEnd();
    if (words.length > 0) commands.push({ words, after });
    words = [];
    after = operator;
  };
  const cut = (): { commands: ShellCommand[]; complete: boolean } => {
    commandEnd("");
    return { commands, complete: false };
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const two = text.slice(i, i + 2);
    let end = -1;
    if (ch === "'") {
      end = text.indexOf("'", i + 1);
      if (end < 0) return cut();
      put(text.slice(i + 1, end));
    } else if (ch === '"') {
      end = doubleQuoteEnd(text, i);
      if (end < 0) return cut();
      const inner = text.slice(i + 1, end);
      put(inner, /[$`]/.test(inner));
    } else if (ch === "`") {
      end = text.indexOf("`", i + 1);
      if (end < 0) return cut();
      put("", true);
    } else if (text.startsWith("${{", i)) {
      end = text.indexOf("}}", i);
      if (end < 0) return cut();
      end += 1;
      put("", true);
    } else if (two === "$(") {
      end = parenEnd(text, i + 1);
      if (end < 0) return cut();
      put("", true);
    } else if (two === "${") {
      end = text.indexOf("}", i);
      if (end < 0) return cut();
      put("", true);
    } else if (two === "$'") {
      end = text.indexOf("'", i + 2);
      if (end < 0) return cut();
      put(text.slice(i + 2, end));
    }
    if (end >= 0) {
      i = end + 1;
      continue;
    }
    if (ch === "\\") {
      put(text[i + 1] ?? "");
      i += 2;
    } else if (ch === "$") {
      put("$", true);
      i++;
    } else if (ch === "#" && !word) {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? text.length : eol;
    } else if (two === "<<" && text[i + 2] !== "<") {
      return cut();
    } else if (ch === "\n") {
      commandEnd("\n");
      i++;
    } else if (/\s/.test(ch)) {
      wordEnd();
      i++;
    } else if (two === "&&" || two === "||" || two === ";;") {
      commandEnd(two);
      i += 2;
    } else if (ch === "&" && (text[i - 1] === ">" || text[i + 1] === ">")) {
      put(ch);
      i++;
    } else if (ch === ";" || ch === "|" || ch === "&") {
      commandEnd(ch);
      i++;
    } else if (ch === "(" || ch === ")") {
      commandEnd(after);
      commands.push({ words: [{ text: ch, dynamic: false }], after });
      after = ch;
      i++;
    } else {
      put(ch);
      i++;
    }
  }
  commandEnd("");
  return { commands, complete: true };
}

// ── What a `git add` stages ──────────────────────────────────────────────

interface GitAdd {
  /** Stages state/, when run from the repository root. */
  state: boolean;
  /** Stages .vapi-state.*.json, when run from the repository root. */
  old: boolean;
  /** Stages everything, so it only counts as a command of its own. */
  everything: boolean;
  /** Every pathspec was read and none of them could be part of state/. */
  plain: boolean;
}

const UNREAD: GitAdd = {
  state: false,
  old: false,
  everything: false,
  plain: false,
};

// Flags that don't change which paths are staged.
const ADD_FLAGS = new Set(["-A", "--all", "-f", "--force", "-v", "--verbose"]);

function gitAddRead(args: ShellWord[]): GitAdd {
  let all = false;
  let pathsOnly = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const { text, dynamic } = args[i]!;
    // A redirection, with its target attached or as the next word.
    if (/^(\d*(>>?|<)|&>>?)$/.test(text)) i++;
    else if (/^(\d*[<>]|&>)/.test(text)) continue;
    else if (dynamic) return UNREAD;
    else if (!pathsOnly && text === "--") pathsOnly = true;
    else if (!pathsOnly && text.startsWith("-")) {
      if (!ADD_FLAGS.has(text)) return UNREAD;
      if (text === "-A" || text === "--all") all = true;
    } else paths.push(text);
  }
  if (paths.length === 0)
    return all
      ? { state: true, old: true, everything: true, plain: true }
      : UNREAD;
  const read: GitAdd = {
    state: false,
    old: false,
    everything: false,
    plain: true,
  };
  for (let path of paths) {
    const magic = /^:\(([a-z,]*)\)/.exec(path);
    if (magic) {
      if (!/^(glob|top|literal|,)*$/.test(magic[1]!)) return UNREAD;
      path = path.slice(magic[0].length);
    } else if (path.startsWith(":/")) path = path.slice(2);
    else if (path.startsWith(":")) return UNREAD;
    path = path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (path === "" || path === ".")
      read.state = read.old = read.everything = true;
    else if (/^state(\/\*\*)?$/.test(path)) read.state = true;
    else if (/^\.vapi-state\.[^/]*\.json$/.test(path)) read.old = true;
    else if (/^state\//.test(path) || /^[*?[]/.test(path)) read.plain = false;
  }
  return read;
}

const BLOCK_OPEN = new Map([
  ["if", "if"],
  ["for", "loop"],
  ["while", "loop"],
  ["until", "loop"],
  ["select", "loop"],
  ["case", "case"],
]);
const BLOCK_CLOSE = new Map([
  ["fi", "if"],
  ["done", "loop"],
  ["esac", "case"],
  ["}", "brace"],
]);

// Every `git add` a script runs, read as run from the repository root unless
// `atRoot` is false. One counts only as a command of its own: not after a
// change of directory, not after "||" or a pipe, not inside a loop, a
// function, a group or a subshell. An `if` around it is allowed when it names
// its paths, because that is how a step guards a path that may not exist.
function scriptAddsRead(script: string, atRoot: boolean): GitAdd[] {
  const { commands, complete } = shellCommandsRead(script);
  const adds: GitAdd[] = [];
  const blocks: string[] = [];
  let placed = atRoot;
  let condition = false;
  for (const command of commands) {
    let words = command.words;
    let first = words[0]!.text;
    if (first === "(") blocks.push("paren");
    else if (first === ")" && blocks.at(-1) === "paren") blocks.pop();
    else if (BLOCK_CLOSE.has(first) && blocks.at(-1) === BLOCK_CLOSE.get(first))
      blocks.pop();
    const opened = BLOCK_OPEN.get(first);
    if (opened) {
      blocks.push(opened);
      condition = first !== "for" && first !== "select" && first !== "case";
      continue;
    }
    if (first === "elif") condition = true;
    if (first === "then" || first === "do" || first === "else") {
      condition = false;
      words = words.slice(1);
    }
    while (words[0]?.text === "{" || words[0]?.text === "function") {
      blocks.push("brace");
      words = words.slice(words[0].text === "{" ? 1 : words.length);
    }
    if (words.length > 1 && words.at(-1)!.text === "{") blocks.push("brace");
    if (words[0]?.text === "builtin" || words[0]?.text === "command")
      words = words.slice(1);
    first = words[0]?.text ?? "";
    // From here on the script may be somewhere else, or in another repository.
    if (
      ["cd", "pushd", "popd", "source", ".", "eval"].includes(first) ||
      words.some((word) => /^GIT_(DIR|WORK_TREE|INDEX_FILE)=/.test(word.text))
    )
      placed = false;
    if (first !== "git" || words[1]?.text !== "add" || words[1].dynamic)
      continue;
    const add = gitAddRead(words.slice(2));
    const alone =
      placed &&
      !condition &&
      command.after !== "||" &&
      command.after !== "|" &&
      blocks.every((block) => block === "if") &&
      (!add.everything || blocks.length === 0);
    adds.push(alone ? add : UNREAD);
  }
  // What follows a here-document or an unclosed quote was not read.
  if (!complete) adds.push(UNREAD);
  return adds;
}

// ── A job, a workflow, the repository ─────────────────────────────────────

type JobRead = "stages-both" | "stages" | "stale" | "unseen" | "quiet";

const GIT_ADD = /\bgit\b(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+add\b/g;

function permissionsWrite(permissions: unknown): boolean | undefined {
  if (permissions === undefined) return undefined;
  return (
    permissions === "write-all" ||
    (isRecord(permissions) && permissions.contents === "write")
  );
}

function workingDirectory(holder: unknown): unknown {
  if (!isRecord(holder) || !isRecord(holder.defaults)) return undefined;
  return isRecord(holder.defaults.run)
    ? holder.defaults.run["working-directory"]
    : undefined;
}

function jobRead(job: unknown, workflow: Record<string, unknown>): JobRead {
  if (!isRecord(job)) return "unseen";
  const steps = Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
  // A checkout into a sub-folder, or a default working directory, means no
  // step of this job runs at the repository root.
  const jobAtRoot =
    workingDirectory(job) === undefined &&
    workingDirectory(workflow) === undefined &&
    !steps.some(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/checkout") &&
        isRecord(step.with) &&
        step.with.path !== undefined,
    ) &&
    !/GIT_(DIR|WORK_TREE|INDEX_FILE)/.test(JSON.stringify(job.env ?? {})) &&
    !/GIT_(DIR|WORK_TREE|INDEX_FILE)/.test(JSON.stringify(workflow.env ?? {}));
  const adds: GitAdd[] = [];
  let mentions = 0;
  let commits = false;
  for (const step of steps) {
    if (typeof step.run !== "string") continue;
    // Counted outside comments, to compare with the ones that were read.
    mentions += step.run.replace(/^\s*#.*$/gm, "").match(GIT_ADD)?.length ?? 0;
    if (/\bgit\b[^\n]*\b(add|commit|push)\b/.test(step.run)) commits = true;
    const shell = typeof step.shell === "string" ? step.shell : "bash";
    const atRoot =
      jobAtRoot &&
      step["working-directory"] === undefined &&
      !/GIT_(DIR|WORK_TREE|INDEX_FILE)/.test(JSON.stringify(step.env ?? {})) &&
      /^(bash|sh)\b/.test(shell);
    adds.push(...scriptAddsRead(step.run, atRoot));
  }
  if (adds.some((add) => add.state))
    return adds.some((add) => add.old) ? "stages-both" : "stages";
  // Seen to stage the old file, with every `git add` in the job read and
  // none of them able to stage state/.
  if (
    adds.some((add) => add.old) &&
    adds.every((add) => add.plain) &&
    adds.length === mentions
  )
    return "stale";
  // A job whose token can't write and that runs no git command to commit
  // with shows no commit step. Anything else may commit in a way not read.
  const writes =
    permissionsWrite(job.permissions) ?? permissionsWrite(workflow.permissions);
  return writes === false && !commits ? "quiet" : "unseen";
}

// A file that doesn't parse may commit in a way not read.
function workflowJobsRead(path: string): JobRead[] {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return ["unseen"];
  }
  if (!isRecord(doc) || !isRecord(doc.jobs)) return ["unseen"];
  const workflow = doc;
  return Object.values(doc.jobs).map((job) => jobRead(job, workflow));
}

function workflowsRead(rootDir: string): { file: string; jobs: JobRead[] }[] {
  const dir = join(rootDir, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({
      file: `.github/workflows/${name}`,
      jobs: workflowJobsRead(join(dir, name)),
    }));
}

/**
 * What is seen of the step that commits state after a run. In GitHub Actions
 * the engine knows which workflow is running it and reads that one alone;
 * anywhere else it reads every workflow in .github/workflows/.
 *
 * "seen" needs every job that shows a commit step to stage state/. A pipeline
 * the engine has no file for (another CI system, a script that commits with
 * its own token) is not read at all, which is why `npm run migrate` always
 * says what the commit step has to stage.
 */
export function commitStepRead(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CommitStep {
  const every = workflowsRead(rootDir);
  const running =
    env.GITHUB_ACTIONS === "true"
      ? /\.github\/workflows\/[^@]+/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[0]
      : undefined;
  const own = every.filter((workflow) => workflow.file === running);
  const workflows = own.length > 0 ? own : every;
  const stale = workflows.find((workflow) => workflow.jobs.includes("stale"));
  if (stale) return { kind: "stale", file: stale.file };
  const unseen = workflows.find((workflow) => workflow.jobs.includes("unseen"));
  if (unseen) return { kind: "unseen", file: unseen.file };
  const staging = workflows.flatMap((workflow) =>
    workflow.jobs.filter((job) => job !== "quiet"),
  );
  return staging.length > 0
    ? { kind: "seen", stagesOld: staging.every((job) => job === "stages-both") }
    : { kind: "none" };
}
