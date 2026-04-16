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
  /** Start with all groups collapsed (default: false) */
  collapsed?: boolean;
}

export const BACK_SENTINEL = "__BACK__";

interface HeaderEntry {
  type: "header";
  group: string;
  /** selected / total counts for display */
  sel: number;
  total: number;
  expanded: boolean;
  matchCount: number;
}

interface ItemEntry {
  type: "item";
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
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cursorHide: "\x1b[?25l",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Extract unique group names in the order they first appear */
function groupNames(choices: Choice[]): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const c of choices) {
    if (!seen.has(c.group)) {
      seen.add(c.group);
      groups.push(c.group);
    }
  }
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

export default createPrompt<string[], Config>((config, done) => {
  const { choices, pageSize = 20 } = config;
  const allGroups = groupNames(choices);

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
  // cursor indexes into the display[] array (headers + visible items)
  const [cursor, setCursor] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(config.collapsed ? allGroups : []),
  );

  // ── Build filtered indices per group ────────────────────────────────────

  const isSearching = filter.length > 0;
  const lower = filter.toLowerCase();

  // Map: group → array of original choice indices that match the filter
  const filteredByGroup = new Map<string, number[]>();
  for (const group of allGroups) {
    filteredByGroup.set(group, []);
  }
  for (let i = 0; i < choices.length; i++) {
    const c = choices[i]!;
    if (
      !isSearching ||
      c.name.toLowerCase().includes(lower) ||
      c.group.toLowerCase().includes(lower)
    ) {
      filteredByGroup.get(c.group)!.push(i);
    }
  }

  // ── Build display list ──────────────────────────────────────────────────

  const display: DisplayEntry[] = [];

  for (const group of allGroups) {
    const matchingIndices = filteredByGroup.get(group)!;
    if (matchingIndices.length === 0) continue;

    const totalInGroup = choices.filter((c) => c.group === group).length;
    const selInGroup = choices.filter(
      (c, i) => c.group === group && selected.has(i),
    ).length;

    // When searching, force expand groups with matches
    const isExpanded = isSearching || !collapsedGroups.has(group);

    display.push({
      type: "header",
      group,
      sel: selInGroup,
      total: totalInGroup,
      expanded: isExpanded,
      matchCount: matchingIndices.length,
    });

    if (isExpanded) {
      for (const ci of matchingIndices) {
        display.push({ type: "item", ci });
      }
    }
  }

  const maxCursor = Math.max(0, display.length - 1);
  const safeCursor = Math.max(0, Math.min(cursor, maxCursor));

  // Helper: get the group name for the current cursor position
  const currentEntry = display[safeCursor];
  const currentGroup: string | undefined =
    currentEntry?.type === "header"
      ? currentEntry.group
      : currentEntry?.type === "item"
        ? choices[currentEntry.ci]!.group
        : undefined;

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

    // Right arrow: expand group (on header) or no-op on item
    if (key.name === "right") {
      if (currentEntry?.type === "header" && !isSearching) {
        const next = new Set(collapsedGroups);
        next.delete(currentEntry.group);
        setCollapsedGroups(next);
      }
      return;
    }

    // Left arrow: collapse group (on header), or jump to group header (on item)
    if (key.name === "left") {
      if (!isSearching) {
        if (currentEntry?.type === "header") {
          const next = new Set(collapsedGroups);
          next.add(currentEntry.group);
          setCollapsedGroups(next);
        } else if (currentEntry?.type === "item" && currentGroup) {
          // Jump cursor to this item's group header
          const headerIdx = display.findIndex(
            (d) => d.type === "header" && d.group === currentGroup,
          );
          if (headerIdx >= 0) setCursor(headerIdx);
        }
      }
      return;
    }

    if (isSpaceKey(key)) {
      if (currentEntry?.type === "header") {
        // Toggle all items in this group
        const groupIndices = filteredByGroup.get(currentEntry.group) ?? [];
        const allChecked = groupIndices.every((i) => selected.has(i));
        const next = new Set(selected);
        for (const i of groupIndices) {
          if (allChecked) next.delete(i);
          else next.add(i);
        }
        setSelected(next);
      } else if (currentEntry?.type === "item") {
        const ci = currentEntry.ci;
        const next = new Set(selected);
        if (next.has(ci)) next.delete(ci);
        else next.add(ci);
        setSelected(next);
      }
      return;
    }

    // Ctrl+A: toggle all visible
    if (key.ctrl && key.name === "a") {
      const visibleIndices = display
        .filter((d): d is ItemEntry => d.type === "item")
        .map((d) => d.ci);
      // Also include collapsed group items so ctrl+a truly means "all filtered"
      const allFilteredIndices = new Set<number>();
      for (const indices of filteredByGroup.values()) {
        for (const i of indices) allFilteredIndices.add(i);
      }
      const target = visibleIndices.length > 0 ? [...allFilteredIndices] : [];
      const allChecked = target.every((i) => selected.has(i));
      const next = new Set(selected);
      for (const i of target) {
        if (allChecked) next.delete(i);
        else next.add(i);
      }
      setSelected(next);
      return;
    }

    // Ctrl+G: toggle all in the current group
    if (key.ctrl && key.name === "g") {
      if (currentGroup) {
        const groupIndices = filteredByGroup.get(currentGroup) ?? [];
        const allChecked = groupIndices.every((i) => selected.has(i));
        const next = new Set(selected);
        for (const i of groupIndices) {
          if (allChecked) next.delete(i);
          else next.add(i);
        }
        setSelected(next);
      }
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

    // Printable character
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

  // Paginate around cursor position
  const half = Math.floor(pageSize / 2);
  let start = Math.max(0, safeCursor - half);
  start = Math.min(start, Math.max(0, display.length - pageSize));
  const end = Math.min(start + pageSize, display.length);

  const lines: string[] = [];
  lines.push(`${prefix} ${esc.bold(config.message)}`);

  if (filter) {
    lines.push(`  ${esc.dim("Search:")} ${filter}▏ ${esc.dim("(esc to clear)")}`);
  } else {
    lines.push(`  ${esc.dim("Type to search…  ←/→: collapse/expand  (esc to go back)")}`);
  }
  lines.push("");

  if (display.length === 0) {
    lines.push(`  ${esc.dim("No matches")}`);
  } else {
    if (start > 0) lines.push(`  ${esc.dim("  ↑ more above")}`);

    for (let di = start; di < end; di++) {
      const entry = display[di]!;
      const isCursor = di === safeCursor;

      if (entry.type === "header") {
        const arrow = entry.expanded ? "▾" : "▸";
        const counts = isSearching
          ? `${entry.matchCount} match${entry.matchCount === 1 ? "" : "es"}`
          : `${entry.sel}/${entry.total}`;
        const ptr = isCursor ? esc.cyan("❯") : " ";
        const label = isCursor
          ? esc.bold(`${arrow} ${entry.group} (${counts})`)
          : esc.dim(`${arrow} ${entry.group} (${counts})`);
        lines.push(`  ${ptr} ${label}`);
      } else {
        const choice = choices[entry.ci]!;
        const isChecked = selected.has(entry.ci);
        const ptr = isCursor ? esc.cyan("❯") : " ";
        const ico = isChecked ? esc.green("◉") : esc.dim("◯");
        const lbl = isCursor ? esc.bold(choice.name) : choice.name;
        lines.push(`  ${ptr}   ${ico} ${lbl}`);
      }
    }

    const remaining = display.length - end;
    if (remaining > 0) lines.push(`  ${esc.dim(`  ↓ ${remaining} more below`)}`);
  }

  lines.push("");
  const backHint = config.allowBack !== false ? "  ·  esc: back" : "";
  lines.push(
    `  ${esc.dim(`${selected.size}/${choices.length} selected  ·  space: toggle  ·  ctrl+g: group  ·  ctrl+a: all  ·  enter: confirm${backHint}`)}`,
  );

  return `${lines.join("\n")}${esc.cursorHide}`;
});
