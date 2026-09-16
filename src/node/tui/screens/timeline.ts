// The workspace itself: recent events above the prompt, or the command menu
// when what's being typed starts with a "/".

import type { LoadedEntry } from "../../../core/layout.ts";
import type { Command } from "../commands.ts";
import { bold, dim } from "../text.ts";
import { list, row } from "./chrome.ts";
import type { Scrolled } from "./chrome.ts";

export interface TimelineView {
  entries: LoadedEntry[];
  /** -1 when the prompt has the attention; 0 is the newest event. */
  selected: number;
  scroll: number | null;
  width: number;
  rows: number;
}

export function timeline(v: TimelineView): Scrolled {
  if (!v.entries.length) {
    const blurb = [dim("  Nothing logged yet."), "", dim("  Type what happened below and press Enter."), dim("  Press / for commands, or Ctrl+O for the full composer.")];
    return { lines: [...Array(Math.max(0, v.rows - blurb.length)).fill(""), ...blurb], scroll: 0 };
  }
  // Newest last, so the most recent event sits right above the prompt.
  const rows = v.entries.map((e) => row(e, v.width)).reverse();
  const selected = v.selected >= 0 ? rows.length - 1 - Math.min(v.selected, rows.length - 1) : -1;
  const bottom = Math.max(0, rows.length - v.rows);
  const { lines, scroll } = list(rows, selected, v.scroll ?? bottom, v.width, v.rows);
  // Keep the newest event right above the prompt, even when there are only a few.
  return { lines: [...Array(Math.max(0, v.rows - lines.length)).fill(""), ...lines], scroll: selected < 0 ? bottom : scroll };
}

export interface MenuView {
  matches: Command[];
  index: number;
  width: number;
  rows: number;
}

export function menu(v: MenuView): string[] {
  if (!v.matches.length) return [dim("  No command by that name. Press Esc to go back to writing.")];
  const nameWidth = Math.max(...v.matches.map((c) => c.name.length)) + 2;
  const rows = v.matches.map((c) => `${`/${c.name}`.padEnd(nameWidth + 1)}${c.summary}`);
  return [bold(" Commands"), ...list(rows, v.index, 0, v.width, Math.max(1, v.rows - 1)).lines];
}
