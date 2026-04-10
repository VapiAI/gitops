import {
  createPrompt,
  useState,
  useKeypress,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isEnterKey,
} from "@inquirer/core";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Choice {
  value: string;
  name: string;
  group: string;
  checked?: boolean;
}

interface Config {
  message: string;
  choices: Choice[];
  pageSize?: number;
  allowBack?: boolean;
}

export const BACK_SENTINEL = "__BACK__";

interface HeaderEntry {
  type: "header";
  text: string;
}

interface ItemEntry {
  type: "item";
  /** Index into the filtered array */
  fi: number;
  /** Index into the original choices array */
  ci: number;
}

type DisplayEntry = HeaderEntry | ItemEntry;

// ─────────────────────────────────────────────────────────────────────────────
// ANSI helpers
// ─────────────────────────────────────────────────────────────────────────────

const esc = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  cursorHide: "\x1b[?25l",
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

export default createPrompt<string[], Config>((config, done) => {
  const { choices, pageSize = 20 } = config;

  const [status, setStatus] = useState<string>("active");
  const [selected, setSelected] = useState<Set<number>>(
    () =>
      new Set(
        choices.reduce<number[]>((acc, c, i) => {
          if (c.checked === true) acc.push(i);
          return acc;
        }, []),
      ),
  );
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);

  // Indices of choices matching the current filter
  const filtered: number[] = (() => {
    if (!filter) return choices.map((_, i) => i);
    const lower = filter.toLowerCase();
    return choices.reduce<number[]>((acc, c, i) => {
      if (
        c.name.toLowerCase().includes(lower) ||
        c.group.toLowerCase().includes(lower)
      ) {
        acc.push(i);
      }
      return acc;
    }, []);
  })();

  const maxCursor = Math.max(0, filtered.length - 1);
  const safeCursor = Math.max(0, Math.min(cursor, maxCursor));

  // ── Keypress handler ────────────────────────────────────────────────────

  useKeypress((key) => {
    if (isEnterKey(key)) {
      setStatus("done");
      done(choices.filter((_, i) => selected.has(i)).map((c) => c.value));
      return;
    }

    if (isUpKey(key)) {
      setCursor(Math.max(0, safeCursor - 1));
      return;
    }

    if (isDownKey(key)) {
      setCursor(Math.min(maxCursor, safeCursor + 1));
      return;
    }

    if (isSpaceKey(key)) {
      if (filtered.length > 0 && filtered[safeCursor] !== undefined) {
        const ci = filtered[safeCursor]!;
        const next = new Set(selected);
        if (next.has(ci)) next.delete(ci);
        else next.add(ci);
        setSelected(next);
      }
      return;
    }

    // Ctrl+A: toggle all visible
    if (key.ctrl && key.name === "a") {
      const allChecked = filtered.every((i) => selected.has(i));
      const next = new Set(selected);
      for (const i of filtered) {
        if (allChecked) next.delete(i);
        else next.add(i);
      }
      setSelected(next);
      return;
    }

    if (key.name === "backspace") {
      if (filter.length > 0) {
        setFilter(filter.slice(0, -1));
        setCursor(0);
      }
      return;
    }

    if (key.name === "escape") {
      if (filter) {
        setFilter("");
        setCursor(0);
      } else if (config.allowBack !== false) {
        setStatus("done");
        done([BACK_SENTINEL]);
      }
      return;
    }

    // Printable character (space is already handled as toggle)
    if (
      !key.ctrl &&
      !key.shift &&
      key.name &&
      key.name.length === 1 &&
      key.name.charCodeAt(0) >= 33 &&
      key.name.charCodeAt(0) <= 126
    ) {
      setFilter(filter + key.name);
      setCursor(0);
    }
  });

  // ── Render ──────────────────────────────────────────────────────────────

  const prefix = status === "done" ? esc.green("✔") : esc.green("?");

  if (status === "done") {
    return `${prefix} ${esc.bold(config.message)} ${esc.cyan(`${selected.size} selected`)}`;
  }

  // Build display list: group headers interleaved with items
  const display: DisplayEntry[] = [];
  let lastGroup = "";
  for (let fi = 0; fi < filtered.length; fi++) {
    const ci = filtered[fi]!;
    const choice = choices[ci]!;
    if (choice.group !== lastGroup) {
      lastGroup = choice.group;
      const total = choices.filter((c) => c.group === choice.group).length;
      const sel = choices.filter(
        (c, i) => c.group === choice.group && selected.has(i),
      ).length;
      display.push({ type: "header", text: `${choice.group} (${sel}/${total})` });
    }
    display.push({ type: "item", fi, ci });
  }

  // Locate cursor inside the display list
  const cursorDisplayIdx = display.findIndex(
    (d) => d.type === "item" && d.fi === safeCursor,
  );

  // Paginate around cursor position
  const half = Math.floor(pageSize / 2);
  let start = Math.max(0, (cursorDisplayIdx >= 0 ? cursorDisplayIdx : 0) - half);
  start = Math.min(start, Math.max(0, display.length - pageSize));
  const end = Math.min(start + pageSize, display.length);

  const lines: string[] = [];
  lines.push(`${prefix} ${esc.bold(config.message)}`);

  if (filter) {
    lines.push(`  ${esc.dim("Search:")} ${filter}▏ ${esc.dim("(esc to clear)")}`);
  } else {
    lines.push(`  ${esc.dim("Type to search…  (esc to go back)")}`);
  }
  lines.push("");

  if (filtered.length === 0) {
    lines.push(`  ${esc.dim("No matches")}`);
  } else {
    if (start > 0) lines.push(`  ${esc.dim("  ↑ more above")}`);

    for (let di = start; di < end; di++) {
      const entry = display[di]!;
      if (entry.type === "header") {
        lines.push(`  ${esc.dim(`── ${entry.text} ──`)}`);
      } else {
        const choice = choices[entry.ci]!;
        const isCursor = entry.fi === safeCursor;
        const isChecked = selected.has(entry.ci);
        const ptr = isCursor ? esc.cyan("❯") : " ";
        const ico = isChecked ? esc.green("◉") : esc.dim("◯");
        const lbl = isCursor ? esc.bold(choice.name) : choice.name;
        lines.push(`  ${ptr} ${ico} ${lbl}`);
      }
    }

    const remaining = display.length - end;
    if (remaining > 0) lines.push(`  ${esc.dim(`  ↓ ${remaining} more below`)}`);
  }

  lines.push("");
  const backHint = config.allowBack !== false ? "  ·  esc: back" : "";
  lines.push(
    `  ${esc.dim(`${selected.size}/${choices.length} selected  ·  space: toggle  ·  ctrl+a: all/none  ·  enter: confirm${backHint}`)}`,
  );

  return `${lines.join("\n")}${esc.cursorHide}`;
});
